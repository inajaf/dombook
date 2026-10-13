// Package domainservice orchestrates the domain operations: it validates input,
// resolves the context a rule needs, and delegates persistence to the store.
//
// It exists as its own layer rather than living inside the HTTP handlers for one
// reason: sync v2 will apply the same rules to pushed rows. A handler that inlined the
// validation would have to be duplicated there, and the two copies would drift — which
// is precisely the class of bug the shared fixtures exist to prevent.
package domainservice

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/inajaf/dombook/server/internal/billing"
	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// Store is the persistence the service needs.
type Store interface {
	GetAccountByID(ctx context.Context, accountID string) (*store.Account, error)

	ListPlaces(ctx context.Context, tenantID string) ([]store.Place, error)
	GetPlace(ctx context.Context, tenantID, placeID string) (*store.Place, error)
	CreatePlace(ctx context.Context, tenantID string, input *domain.PlaceInput, writer string) (*store.Place, error)
	UpdatePlace(ctx context.Context, tenantID, placeID string, input *domain.PlaceInput, writer string) (*store.Place, error)
	SetPlaceStatus(ctx context.Context, tenantID, placeID, status, writer string) (*store.Place, error)
	SoftDeletePlace(ctx context.Context, tenantID, placeID, writer string) error

	ListUnits(ctx context.Context, tenantID string, placeID *string) ([]store.Unit, error)
	GetUnit(ctx context.Context, tenantID, unitID string) (*store.Unit, error)
	CreateUnit(ctx context.Context, tenantID string, input *domain.UnitInput, writer string) (*store.Unit, error)
	UpdateUnit(ctx context.Context, tenantID, unitID string, input *domain.UnitInput, writer string) (*store.Unit, error)
	SetUnitStatus(ctx context.Context, tenantID, unitID, status, writer string) (*store.Unit, error)
	SoftDeleteUnit(ctx context.Context, tenantID, unitID, writer string) error

	ListReservations(ctx context.Context, tenantID string) ([]store.Reservation, error)
	GetReservation(ctx context.Context, tenantID, reservationID string) (*store.Reservation, error)
	CreateReservation(ctx context.Context, tenantID string, input *domain.ReservationInput, writer string) (*store.Reservation, error)
	UpdateReservation(ctx context.Context, tenantID, reservationID string, input *domain.ReservationInput, writer string) (*store.Reservation, error)
	CancelReservation(ctx context.Context, tenantID, reservationID, writer string) (*store.Reservation, error)
	DeleteReservation(ctx context.Context, tenantID, reservationID, writer string) error
	TakenNights(ctx context.Context, tenantID, unitID string, nights []domain.Date) ([]domain.Date, error)

	UpdateBookingPolicy(ctx context.Context, accountID string, policy store.BookingPolicyConfig) (*store.Account, error)
	ActiveEntitlements(ctx context.Context, accountID string) ([]store.Entitlement, error)
	EntitlementHistory(ctx context.Context, accountID string, limit int) ([]store.Entitlement, error)
	GetTenantState(ctx context.Context, tenantID string) (*store.TenantState, error)
	Pull(ctx context.Context, tenantID string, since int64) (*store.PullChanges, int64, error)
	Push(ctx context.Context, tenantID, clientID string, changes map[store.SyncTable][]store.SyncRow) (*store.PushResult, error)
}

// Options configures the service.
type Options struct {
	// TimeZone is the fallback zone for computing "today" when an account has no policy
	// override.
	TimeZone string
	// Now is the instantaneous clock. Tests pin it so a booking-window assertion means
	// exactly what it says rather than depending on when the suite ran.
	//
	// A single clock feeds BOTH the validator and the policy view on purpose: two sources
	// could let the "today" reported to a client differ from the day the validator applied,
	// and the client would then offer dates the server refuses.
	Now func() time.Time
}

// Service implements the domain operations.
type Service struct {
	store Store
	now   func() time.Time
}

// New builds the service.
func New(repository Store, options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{store: repository, now: now}
}

// todayIn resolves the current calendar date in a policy's timezone.
func (s *Service) todayIn(policy domain.Policy) (domain.Date, error) {
	return domain.TodayInTimeZone(s.now(), policy.TimeZone)
}

// policyFor resolves an account's booking policy, falling back to the shipped defaults
// for any field the account has not overridden.
//
// Filling gaps rather than requiring a complete policy means a partially configured
// account still books instead of locking out: a zero advance window would forbid every
// date.
func (s *Service) policyFor(ctx context.Context, tenantID string) (domain.Policy, error) {
	account, err := s.store.GetAccountByID(ctx, tenantID)
	if err != nil {
		return domain.DefaultPolicy, err
	}
	return policyFromAccount(account), nil
}

// policyFromAccount maps the stored JSON policy onto the typed policy, applying defaults
// to unset fields.
func policyFromAccount(account *store.Account) domain.Policy {
	policy := domain.DefaultPolicy
	if account == nil {
		return policy
	}
	if account.BookingPolicy.MaximumAdvanceDays != nil {
		policy.MaximumAdvanceDays = *account.BookingPolicy.MaximumAdvanceDays
	}
	if account.BookingPolicy.MaximumStayMonths != nil {
		policy.MaximumStayMonths = *account.BookingPolicy.MaximumStayMonths
	}
	if account.BookingPolicy.MaximumTenancyMonths != nil {
		policy.MaximumTenancyMonths = *account.BookingPolicy.MaximumTenancyMonths
	}
	if account.BookingPolicy.TimeZone != nil && *account.BookingPolicy.TimeZone != "" {
		policy.TimeZone = *account.BookingPolicy.TimeZone
	}
	return policy
}

// translate turns a store or validation error into the wire error a client should see.
//
// The mapping lives in one place so a new caller cannot accidentally leak a raw database
// message: anything unrecognized becomes an internal error with no detail.
func translate(err error) error {
	if err == nil {
		return nil
	}

	var apiErr *httpapi.ApiError
	if errors.As(err, &apiErr) {
		return apiErr
	}

	if fieldErr, ok := domain.AsFieldError(err); ok {
		// The field name is included in details so a form can highlight the input.
		return httpapi.BadRequestWithField(fieldErr.Code, fieldErr.Message, fieldErr.Field)
	}
	if violation, ok := domain.AsViolation(err); ok {
		return httpapi.BadRequest(violation.Code, violation.Message, nil)
	}

	var conflict *store.ConflictError
	if errors.As(err, &conflict) {
		dates := make([]string, 0, len(conflict.Dates))
		for _, date := range conflict.Dates {
			dates = append(dates, date.String())
		}
		return httpapi.Conflict("night_conflict", conflict.Message, map[string]any{"dates": dates})
	}

	if errors.Is(err, store.ErrUnitNotBookable) {
		return httpapi.BadRequest("validation_error", "Выберите активный дом", map[string]any{"field": "unitId"})
	}
	if errors.Is(err, store.ErrNotFound) {
		return httpapi.NotFound("not_found", "Запись не найдена")
	}
	// A unique violation on a name is the ordinary "this name is taken" case.
	if store.IsUniqueViolation(err) {
		return httpapi.BadRequest("duplicate_name", "Такое название уже используется", nil)
	}
	if store.IsExclusionViolation(err) {
		return httpapi.Conflict("night_conflict", "На указанные даты дом уже занят другой бронью", nil)
	}
	return err
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

// ListPlaces returns the tenant's places.
func (s *Service) ListPlaces(ctx context.Context, tenantID string) ([]store.Place, error) {
	return s.store.ListPlaces(ctx, tenantID)
}

// GetPlace loads one place.
func (s *Service) GetPlace(ctx context.Context, tenantID, placeID string) (*store.Place, error) {
	place, err := s.store.GetPlace(ctx, tenantID, placeID)
	return place, translate(err)
}

// CreatePlace validates and stores a place.
func (s *Service) CreatePlace(ctx context.Context, tenantID, writer string, payload map[string]any) (*store.Place, error) {
	input, err := domain.ValidatePlace(payload)
	if err != nil {
		return nil, translate(err)
	}
	place, err := s.store.CreatePlace(ctx, tenantID, input, writer)
	return place, translate(err)
}

// UpdatePlace validates and stores changes to a place.
func (s *Service) UpdatePlace(ctx context.Context, tenantID, placeID, writer string, payload map[string]any) (*store.Place, error) {
	input, err := domain.ValidatePlace(payload)
	if err != nil {
		return nil, translate(err)
	}
	place, err := s.store.UpdatePlace(ctx, tenantID, placeID, input, writer)
	return place, translate(err)
}

// SetPlaceStatus archives or restores a place.
func (s *Service) SetPlaceStatus(ctx context.Context, tenantID, placeID, status, writer string) (*store.Place, error) {
	if status != "active" && status != "archived" {
		return nil, httpapi.BadRequest("validation_error", "Недопустимый статус", map[string]any{"field": "status"})
	}
	place, err := s.store.SetPlaceStatus(ctx, tenantID, placeID, status, writer)
	return place, translate(err)
}

// DeletePlace removes a place.
//
// A place that still has units is refused: deleting it would leave units pointing at a
// removed parent, and the owner would rather be told to move or archive them than
// discover orphaned cottages later.
func (s *Service) DeletePlace(ctx context.Context, tenantID, placeID, writer string) error {
	units, err := s.store.ListUnits(ctx, tenantID, &placeID)
	if err != nil {
		return translate(err)
	}
	active := 0
	for _, unit := range units {
		if unit.Status == "active" {
			active++
		}
	}
	if active > 0 {
		return httpapi.Conflict("place_has_units",
			fmt.Sprintf("В доме отдыха %d активных объектов. Архивируйте или перенесите их перед удалением.", active),
			map[string]any{"activeUnits": active})
	}
	return translate(s.store.SoftDeletePlace(ctx, tenantID, placeID, writer))
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

// ListUnits returns the tenant's units, optionally scoped to a place.
func (s *Service) ListUnits(ctx context.Context, tenantID string, placeID *string) ([]store.Unit, error) {
	return s.store.ListUnits(ctx, tenantID, placeID)
}

// GetUnit loads one unit.
func (s *Service) GetUnit(ctx context.Context, tenantID, unitID string) (*store.Unit, error) {
	unit, err := s.store.GetUnit(ctx, tenantID, unitID)
	return unit, translate(err)
}

// unitLookup builds the place resolver the unit validator needs. It runs inside the
// caller's tenant context, so a place belonging to another tenant is simply not found.
func (s *Service) unitLookup(ctx context.Context, tenantID string) domain.UnitLookup {
	return func(placeID string) (exists bool, isActive bool) {
		place, err := s.store.GetPlace(ctx, tenantID, placeID)
		if err != nil || place == nil {
			return false, false
		}
		return true, place.Status == "active"
	}
}

// CreateUnit validates and stores a unit.
func (s *Service) CreateUnit(ctx context.Context, tenantID, writer string, payload map[string]any) (*store.Unit, error) {
	if err := s.assertUnitQuota(ctx, tenantID); err != nil {
		return nil, err
	}
	input, err := domain.ValidateUnit(payload, s.unitLookup(ctx, tenantID))
	if err != nil {
		return nil, translate(err)
	}
	unit, err := s.store.CreateUnit(ctx, tenantID, input, writer)
	return unit, translate(err)
}

// UpdateUnit validates and stores changes to a unit.
func (s *Service) UpdateUnit(ctx context.Context, tenantID, unitID, writer string, payload map[string]any) (*store.Unit, error) {
	// The quota is only relevant when this update makes the unit active.
	if newStatus, ok := payload["status"].(string); ok && newStatus == "active" {
		existing, err := s.store.GetUnit(ctx, tenantID, unitID)
		if err != nil {
			return nil, translate(err)
		}
		if existing.Status != "active" {
			if err := s.assertUnitQuota(ctx, tenantID); err != nil {
				return nil, err
			}
		}
	}

	input, err := domain.ValidateUnit(payload, s.unitLookup(ctx, tenantID))
	if err != nil {
		return nil, translate(err)
	}
	unit, err := s.store.UpdateUnit(ctx, tenantID, unitID, input, writer)
	return unit, translate(err)
}

// SetUnitStatus archives or activates a unit.
func (s *Service) SetUnitStatus(ctx context.Context, tenantID, unitID, status, writer string) (*store.Unit, error) {
	if status != "active" && status != "archived" {
		return nil, httpapi.BadRequest("validation_error", "Недопустимый статус", map[string]any{"field": "status"})
	}
	if status == "active" {
		// Reactivating consumes a slot, so the same limit applies as on create.
		if err := s.assertUnitQuota(ctx, tenantID); err != nil {
			return nil, err
		}
	}
	unit, err := s.store.SetUnitStatus(ctx, tenantID, unitID, status, writer)
	return unit, translate(err)
}

// DeleteUnit removes a unit, refusing when it still has bookings.
func (s *Service) DeleteUnit(ctx context.Context, tenantID, unitID, writer string) error {
	reservations, err := s.store.ListReservations(ctx, tenantID)
	if err != nil {
		return translate(err)
	}
	for _, reservation := range reservations {
		if reservation.UnitID != unitID {
			continue
		}
		// A cancelled booking no longer occupies the unit, so it does not block removal;
		// history is preserved either way because the row is soft-deleted.
		if reservation.Status != string(domain.StatusCancelled) {
			return httpapi.Conflict("unit_has_reservations",
				"У объекта есть бронирования. Отмените их или архивируйте объект.", nil)
		}
	}
	return translate(s.store.SoftDeleteUnit(ctx, tenantID, unitID, writer))
}

// assertUnitQuota rejects a unit activation when the plan's cap is already reached.
//
// This produces the friendly upgrade prompt. It is NOT the guarantee: the database
// trigger runs inside the insert and closes the race between this count and the write.
// Both are needed — the check for the message, the trigger for correctness.
func (s *Service) assertUnitQuota(ctx context.Context, tenantID string) error {
	// Entitlements decide, not the plan column.
	//
	// A one-time purchase is a fact recorded in account_entitlements, and the plan column is
	// a legacy field the older billing code wrote. Reading the plan here would let an
	// account that paid once fall back to the free cap as soon as that column changed — the
	// customer would lose access to units they bought. The entitlement is the authority.
	allowance, err := s.unitAllowance(ctx, tenantID)
	if err != nil {
		return err
	}
	if allowance < 0 {
		return nil // unlimited
	}

	units, err := s.store.ListUnits(ctx, tenantID, nil)
	if err != nil {
		return translate(err)
	}
	active := 0
	for _, unit := range units {
		if unit.Status == "active" {
			active++
		}
	}
	if active >= allowance {
		return httpapi.PlanLimit("units", allowance, active, "free",
			fmt.Sprintf("Бесплатный тариф позволяет не более %d объекта размещения. Пожизненная лицензия снимает ограничение.", allowance))
	}
	return nil
}

// unitAllowance resolves how many active units an account may hold, or -1 for unlimited.
func (s *Service) unitAllowance(ctx context.Context, tenantID string) (int, error) {
	state, err := s.Entitlements(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	return state.UnitAllowance(), nil
}

// Entitlements resolves what an account currently has.
//
// The grants are read from the database and reduced by the billing catalog, so a SKU this
// build does not know grants nothing rather than being trusted on the strength of its row.
func (s *Service) Entitlements(ctx context.Context, tenantID string) (billing.State, error) {
	grants, err := s.store.ActiveEntitlements(ctx, tenantID)
	if err != nil {
		return billing.State{}, translate(err)
	}
	converted := make([]billing.Grant, 0, len(grants))
	for _, grant := range grants {
		converted = append(converted, billing.Grant{
			SKU:       billing.SKU(grant.SKU),
			Source:    billing.Source(grant.Source),
			GrantedAt: grant.GrantedAt,
			ExpiresAt: grant.ExpiresAt,
		})
	}
	return billing.Evaluate(converted, s.now()), nil
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

// ListReservations returns the tenant's bookings.
func (s *Service) ListReservations(ctx context.Context, tenantID string) ([]store.Reservation, error) {
	return s.store.ListReservations(ctx, tenantID)
}

// GetReservation loads one booking.
func (s *Service) GetReservation(ctx context.Context, tenantID, reservationID string) (*store.Reservation, error) {
	reservation, err := s.store.GetReservation(ctx, tenantID, reservationID)
	return reservation, translate(err)
}

// reservationDeps assembles what the reservation validator needs from storage.
func (s *Service) reservationDeps(ctx context.Context, tenantID string, existing *store.Reservation, kind domain.BookingKind) (domain.ReservationDeps, error) {
	policy, err := s.policyFor(ctx, tenantID)
	if err != nil {
		return domain.ReservationDeps{}, translate(err)
	}
	today, err := s.todayIn(policy)
	if err != nil {
		// An unknown timezone is a configuration fault. Falling back to the shipped policy
		// keeps bookings working rather than failing every request, and the validator's own
		// policy check reports the problem.
		policy = domain.DefaultPolicy
		today, err = s.todayIn(policy)
		if err != nil {
			return domain.ReservationDeps{}, err
		}
	}

	deps := domain.ReservationDeps{
		Policy: policy,
		Today:  today,
		Kind:   kind,
		Unit: func(unitID string) (*domain.ValidatedUnit, bool) {
			unit, err := s.store.GetUnit(ctx, tenantID, unitID)
			if err != nil || unit == nil {
				return nil, false
			}
			return &domain.ValidatedUnit{
				ID:               unit.ID,
				PlaceID:          unit.PlaceID,
				Capacity:         unit.Capacity,
				BasePriceMinor:   unit.BasePriceMinor,
				MonthlyRateMinor: unit.MonthlyRateMinor,
				Status:           unit.Status,
			}, true
		},
		PlaceHasFoodService: func(placeID string) bool {
			place, err := s.store.GetPlace(ctx, tenantID, placeID)
			if err != nil || place == nil {
				return false
			}
			return place.HasFoodService
		},
	}

	if existing != nil {
		deps.Existing = &domain.ExistingReservation{
			ID:                 existing.ID,
			UnitID:             existing.UnitID,
			CheckIn:            existing.CheckInDate,
			CheckOut:           existing.CheckOutDate,
			MonthlyRateMinor:   existing.MonthlyRateMinor,
			NightlyRateMinor:   existing.NightlyRateMinor,
			AccommodationMinor: existing.AccommodationMinor,
			ActualCheckOut:     existing.ActualCheckOutDate,
		}
	}
	return deps, nil
}

// CreateReservation validates and stores a booking.
func (s *Service) CreateReservation(ctx context.Context, tenantID, writer string, payload map[string]any) (*store.Reservation, error) {
	// The kind has to be read BEFORE deps are built, because it selects which policy
	// bound the validator applies. Reading it afterwards would validate a tenancy against
	// the stay window and refuse it.
	kind := domain.ParseBookingKind(payload["bookingKind"])
	deps, err := s.reservationDeps(ctx, tenantID, nil, kind)
	if err != nil {
		return nil, err
	}
	input, err := domain.ValidateReservation(payload, deps)
	if err != nil {
		return nil, translate(err)
	}

	// Pre-check the dates so the client gets a message naming the conflicting nights
	// rather than a bare constraint violation. The unique index still decides: between
	// this query and the insert another request can take the same night.
	taken, err := s.store.TakenNights(ctx, tenantID, input.UnitID, input.Nights)
	if err != nil {
		return nil, translate(err)
	}
	if len(taken) > 0 {
		return nil, translate(store.NightsConflictError(taken))
	}

	reservation, err := s.store.CreateReservation(ctx, tenantID, input, writer)
	return reservation, translate(err)
}

// UpdateReservation validates and stores changes to a booking.
func (s *Service) UpdateReservation(ctx context.Context, tenantID, reservationID, writer string, payload map[string]any) (*store.Reservation, error) {
	existing, err := s.store.GetReservation(ctx, tenantID, reservationID)
	if err != nil {
		return nil, translate(err)
	}
	// An edit that does not mention the kind keeps the stored one: a tenancy must not
	// silently become a stay, which would re-judge it against the shorter window.
	kind := domain.ParseBookingKind(existing.BookingKind)
	if _, present := payload["bookingKind"]; present {
		kind = domain.ParseBookingKind(payload["bookingKind"])
	}
	deps, err := s.reservationDeps(ctx, tenantID, existing, kind)
	if err != nil {
		return nil, err
	}
	input, err := domain.ValidateReservation(payload, deps)
	if err != nil {
		return nil, translate(err)
	}

	// The stay's own nights must not count as a conflict with itself.
	others, err := s.store.TakenNights(ctx, tenantID, input.UnitID, input.Nights)
	if err != nil {
		return nil, translate(err)
	}
	if conflict := excludingOwnNights(others, existing.Nights); len(conflict) > 0 {
		return nil, translate(store.NightsConflictError(conflict))
	}

	reservation, err := s.store.UpdateReservation(ctx, tenantID, reservationID, input, writer)
	return reservation, translate(err)
}

// excludingOwnNights filters out nights this reservation already holds.
func excludingOwnNights(taken []domain.Date, own []store.ReservationNight) []domain.Date {
	if len(taken) == 0 {
		return nil
	}
	mine := make(map[string]struct{}, len(own))
	for _, night := range own {
		mine[night.NightDate.String()] = struct{}{}
	}
	var conflict []domain.Date
	for _, night := range taken {
		if _, ok := mine[night.String()]; !ok {
			conflict = append(conflict, night)
		}
	}
	return conflict
}

// CancelReservation cancels a booking and frees its dates.
func (s *Service) CancelReservation(ctx context.Context, tenantID, reservationID, writer string) (*store.Reservation, error) {
	existing, err := s.store.GetReservation(ctx, tenantID, reservationID)
	if err != nil {
		return nil, translate(err)
	}
	if existing.Status == string(domain.StatusCancelled) {
		return nil, httpapi.BadRequest("already_cancelled", "Бронирование уже отменено", nil)
	}
	reservation, err := s.store.CancelReservation(ctx, tenantID, reservationID, writer)
	return reservation, translate(err)
}

// DeleteReservation removes a booking, refusing while it is still active.
//
// The rule is enforced here rather than in the store so the message can explain the
// reason: an owner who tries to delete a live booking needs to be told to cancel it
// first, not handed a constraint error.
func (s *Service) DeleteReservation(ctx context.Context, tenantID, reservationID, writer string) error {
	existing, err := s.store.GetReservation(ctx, tenantID, reservationID)
	if err != nil {
		return translate(err)
	}
	switch domain.ReservationStatus(existing.Status) {
	case domain.StatusCancelled, domain.StatusCheckedOut:
		// Both are finished stays, so removal is a housekeeping action.
	default:
		return httpapi.BadRequest("reservation_active",
			"Сначала отмените бронирование, затем удалите его", nil)
	}
	return translate(s.store.DeleteReservation(ctx, tenantID, reservationID, writer))
}

// ---------------------------------------------------------------------------
// Plan and usage
// ---------------------------------------------------------------------------

// QuotaUsage describes how much of a plan quota is consumed.
type QuotaUsage struct {
	Current   int `json:"current"`
	Limit     int `json:"limit"`
	Remaining int `json:"remaining"`
	// OverLimit reports that the account holds more active rows than its plan allows.
	// It happens after a downgrade, where existing rows are grandfathered rather than
	// deleted, and it is what tells the client to prompt for an upgrade.
	OverLimit bool `json:"overLimit"`
}

// PlanView is the account's plan and its current consumption.
type PlanView struct {
	Plan  string    `json:"plan"`
	Name  string    `json:"name"`
	Today string    `json:"today"`
	Usage PlanUsage `json:"usage"`
}

// PlanUsage groups the per-resource quotas.
type PlanUsage struct {
	Units QuotaUsage `json:"units"`
}

// AccountPlan reports the plan, the resolved booking window's "today", and usage.
func (s *Service) AccountPlan(ctx context.Context, tenantID string) (*PlanView, error) {
	account, err := s.store.GetAccountByID(ctx, tenantID)
	if err != nil {
		return nil, translate(err)
	}
	policy := policyFromAccount(account)
	today, err := s.todayIn(policy)
	if err != nil {
		return nil, err
	}

	units, err := s.store.ListUnits(ctx, tenantID, nil)
	if err != nil {
		return nil, translate(err)
	}
	active := 0
	for _, unit := range units {
		if unit.Status == "active" {
			active++
		}
	}

	// The entitlement is the authority, not `accounts.plan`.
	//
	// That column is a legacy field written by the older subscription billing code. A
	// customer who bought the one-time licence has an entitlement, and reading the column
	// here would report them as free while the quota check lets them work — the two would
	// disagree, and the UI would nag a paying customer to upgrade.
	state, err := s.Entitlements(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	allowance := state.UnitAllowance()
	// Zero is the sentinel for "unlimited", so the client renders no progress bar rather
	// than an empty one.
	limit := allowance
	unlimited := allowance < 0
	if unlimited {
		limit = 0
	}

	usage := QuotaUsage{Current: active, Limit: limit, OverLimit: false}
	if !unlimited {
		usage.Remaining = limit - active
		if usage.Remaining < 0 {
			usage.Remaining = 0
		}
		usage.OverLimit = active > limit
	}

	plan := "free"
	if state.IsPaid() {
		plan = "paid"
	}

	return &PlanView{
		Plan:  plan,
		Name:  planName(plan, state),
		Today: today.String(),
		Usage: PlanUsage{Units: usage},
	}, nil
}

// planName is the human-facing label.
//
// A perpetual licence and an annual one both unlock the same tier, so the label describes
// what the customer has rather than which row produced it.
func planName(plan string, state billing.State) string {
	if plan != "paid" {
		return "Бесплатный"
	}
	for _, sku := range state.SKUs {
		if definition, found := billing.Catalog[sku]; found {
			return definition.Name
		}
	}
	return "Платный"
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// Pull returns every replicated row changed after the given watermark.
func (s *Service) Pull(ctx context.Context, tenantID string, since int64) (*store.PullChanges, int64, error) {
	changes, version, err := s.store.Pull(ctx, tenantID, since)
	return changes, version, translate(err)
}

// Push applies a batch of client changes.
//
// It deliberately does NOT run the same validation as the HTTP CRUD path. Sync carries
// rows a device created while offline, possibly under an older client version; rejecting
// them here would discard work the user already believes is saved. The database
// constraints still hold — a night collision is detected and stored as a conflict — so
// invalid data cannot be introduced, it is only admitted and flagged rather than refused.
func (s *Service) Push(ctx context.Context, tenantID, clientID string, changes map[store.SyncTable][]store.SyncRow) (*store.PushResult, error) {
	result, err := s.store.Push(ctx, tenantID, clientID, changes)
	return result, translate(err)
}

// CurrentVersion reads the tenant's sync watermark.
func (s *Service) CurrentVersion(ctx context.Context, tenantID string) (int64, error) {
	state, err := s.store.GetTenantState(ctx, tenantID)
	if err != nil {
		return 0, translate(err)
	}
	return state.Version, nil
}

// ---------------------------------------------------------------------------
// Booking policy
// ---------------------------------------------------------------------------

// BookingPolicyView is the account's booking window as the client needs it.
//
// `today` is included deliberately: the window is defined relative to the ACCOUNT's
// timezone, so a client that computed "today" from its own clock could disagree with the
// server about which dates are bookable — the exact divergence the shared fixtures exist
// to prevent.
type BookingPolicyView struct {
	MaximumAdvanceDays int `json:"maximumAdvanceDays"`
	MaximumStayMonths  int `json:"maximumStayMonths"`
	// MaximumTenancyMonths bounds a long-term let. Exposed separately because the
	// desktop validates against this value while offline, and a client that saw only
	// the stay bound would refuse legitimate leases.
	MaximumTenancyMonths int    `json:"maximumTenancyMonths"`
	TimeZone             string `json:"timeZone"`
	Today                string `json:"today"`
	MaximumCheckInDate   string `json:"maximumCheckInDate"`
	// IsDefault reports whether the account is on the shipped policy, so the UI can say so
	// instead of implying the owner chose these values.
	IsDefault bool `json:"isDefault"`
}

// BookingPolicy returns the account's effective booking window.
func (s *Service) BookingPolicy(ctx context.Context, tenantID string) (*BookingPolicyView, error) {
	account, err := s.store.GetAccountByID(ctx, tenantID)
	if err != nil {
		return nil, translate(err)
	}
	policy := policyFromAccount(account)

	today, err := s.todayIn(policy)
	if err != nil {
		// An unparseable timezone is a configuration fault. Falling back to the shipped
		// policy keeps bookings working instead of failing every request, and the default
		// is a real zone rather than a guess.
		policy = domain.DefaultPolicy
		today, err = s.todayIn(policy)
		if err != nil {
			return nil, err
		}
	}

	limits := policy.LimitsFor(today, today)
	return &BookingPolicyView{
		MaximumAdvanceDays:   policy.MaximumAdvanceDays,
		MaximumStayMonths:    policy.MaximumStayMonths,
		MaximumTenancyMonths: policy.MaximumTenancyMonths,
		TimeZone:             policy.TimeZone,
		Today:                today.String(),
		MaximumCheckInDate:   limits.MaximumCheckInDate.String(),
		IsDefault:            policy == domain.DefaultPolicy,
	}, nil
}

// BookingPolicyUpdate is a request to change the booking window. Omitted fields keep their
// current values, so a client can change one limit without resending the rest.
type BookingPolicyUpdate struct {
	MaximumAdvanceDays   *int    `json:"maximumAdvanceDays"`
	MaximumStayMonths    *int    `json:"maximumStayMonths"`
	MaximumTenancyMonths *int    `json:"maximumTenancyMonths"`
	TimeZone             *string `json:"timeZone"`
}

// Upper bounds on the policy. Without them an owner could set an advance window of a
// million days, which is not a policy but a way to disable the validation while appearing
// to keep it.
const (
	maxAdvanceDaysLimit = 365
	maxStayMonthsLimit  = 36
	// A tenancy may be far longer than a stay. The bound is above the 24-month
	// default so an owner can extend it, and well below MaxNightCount's reach so the
	// two limits cannot disagree about whether a term is legal.
	maxTenancyMonthsLimit = 60
)

// SetBookingPolicy validates and stores a new booking window.
func (s *Service) SetBookingPolicy(ctx context.Context, tenantID string, update BookingPolicyUpdate) (*BookingPolicyView, error) {
	account, err := s.store.GetAccountByID(ctx, tenantID)
	if err != nil {
		return nil, translate(err)
	}
	current := policyFromAccount(account)

	next := current
	if update.MaximumAdvanceDays != nil {
		next.MaximumAdvanceDays = *update.MaximumAdvanceDays
	}
	if update.MaximumStayMonths != nil {
		next.MaximumStayMonths = *update.MaximumStayMonths
	}
	if update.MaximumTenancyMonths != nil {
		next.MaximumTenancyMonths = *update.MaximumTenancyMonths
	}
	if update.TimeZone != nil {
		next.TimeZone = *update.TimeZone
	}

	// Validate the assembled policy rather than the individual fields: a request that
	// changes only the timezone still has to yield a usable combination, and validating
	// field by field would miss a pair that is individually fine together.
	if err := next.Validate(); err != nil {
		return nil, httpapi.BadRequest("validation_error", "Некорректная политика бронирования",
			map[string]any{"reason": err.Error()})
	}
	if next.MaximumAdvanceDays > maxAdvanceDaysLimit {
		return nil, httpapi.BadRequest("validation_error",
			fmt.Sprintf("Горизонт бронирования: максимум %d дней", maxAdvanceDaysLimit),
			map[string]any{"field": "maximumAdvanceDays", "limit": maxAdvanceDaysLimit})
	}
	if next.MaximumTenancyMonths > maxTenancyMonthsLimit {
		return nil, httpapi.BadRequest("validation_error",
			fmt.Sprintf("Максимальный срок аренды: %d месяцев", maxTenancyMonthsLimit),
			map[string]any{"field": "maximumTenancyMonths", "limit": maxTenancyMonthsLimit})
	}
	if next.MaximumStayMonths > maxStayMonthsLimit {
		return nil, httpapi.BadRequest("validation_error",
			fmt.Sprintf("Максимальная длительность: максимум %d месяцев", maxStayMonthsLimit),
			map[string]any{"field": "maximumStayMonths", "limit": maxStayMonthsLimit})
	}

	advance, months, tenancy, zone := next.MaximumAdvanceDays, next.MaximumStayMonths, next.MaximumTenancyMonths, next.TimeZone
	if _, err := s.store.UpdateBookingPolicy(ctx, tenantID, store.BookingPolicyConfig{
		MaximumAdvanceDays:   &advance,
		MaximumStayMonths:    &months,
		MaximumTenancyMonths: &tenancy,
		TimeZone:             &zone,
	}); err != nil {
		return nil, translate(err)
	}
	return s.BookingPolicy(ctx, tenantID)
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

// EntitlementView is what a client needs to know about the account's licence.
type EntitlementView struct {
	// Paid reports whether the paid tier is unlocked right now.
	Paid bool `json:"paid"`
	// PlanName is the human-facing label.
	PlanName string `json:"planName"`
	// SKUs are the live grants, so the UI can explain what was purchased.
	SKUs []string `json:"skus"`
	// ExpiresAt is when access ends, or null when nothing expires.
	//
	// Null is the meaningful answer for a one-time purchase: it says the licence does not
	// lapse, which a far-future date would only imply.
	ExpiresAt *time.Time `json:"expiresAt"`
	// UnitLimit is the active-unit allowance, or null for unlimited.
	UnitLimit *int `json:"unitLimit"`
	// Features lists what is unlocked, so a client does not have to hardcode which SKU
	// implies which capability.
	Features []string `json:"features"`
	// EvaluatedAt is the server's instant, so a client can tell how stale its cached copy is.
	EvaluatedAt time.Time `json:"evaluatedAt"`
	// RenewalOffered is true when access is time-limited, so the UI can offer renewal
	// without inferring it from an expiry date.
	RenewalOffered bool `json:"renewalOffered"`
}

// EntitlementView reports the account's licence.
func (s *Service) EntitlementView(ctx context.Context, tenantID string) (*EntitlementView, error) {
	state, err := s.Entitlements(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	skus := make([]string, 0, len(state.SKUs))
	features := map[string]bool{}
	for _, sku := range state.SKUs {
		skus = append(skus, string(sku))
		if definition, found := billing.Catalog[sku]; found {
			for _, feature := range definition.Grants {
				features[string(feature)] = true
			}
		}
	}
	featureList := make([]string, 0, len(features))
	// Sorted so the response is stable: an unordered list would make the payload differ
	// between identical requests and defeat any client-side comparison.
	for _, feature := range []billing.Feature{billing.FeaturePaidTier, billing.FeatureWhatsApp} {
		if features[string(feature)] {
			featureList = append(featureList, string(feature))
		}
	}

	view := &EntitlementView{
		Paid:           state.IsPaid(),
		PlanName:       planName(planLabel(state), state),
		SKUs:           skus,
		ExpiresAt:      state.ExpiresAt,
		Features:       featureList,
		EvaluatedAt:    s.now().UTC(),
		RenewalOffered: state.ExpiresAt != nil,
	}
	if allowance := state.UnitAllowance(); allowance >= 0 {
		view.UnitLimit = &allowance
	}
	return view, nil
}

// planLabel is the internal label used for naming.
func planLabel(state billing.State) string {
	if state.IsPaid() {
		return "paid"
	}
	return "free"
}

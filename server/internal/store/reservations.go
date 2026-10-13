package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/inajaf/dombook/server/internal/domain"
)

// Reservation writes are the most intricate part of the store: a booking owns three
// child tables (nights, services, meals), and every one of them participates in the
// double-booking guarantee. Two invariants shape the code below:
//
//  1. The whole graph is written in ONE transaction. A reservation whose nights were
//     inserted but whose services were not is worse than no reservation: it occupies
//     dates without reflecting what the guest owes.
//
//  2. Nights are regenerated rather than patched. Any date change moves the occupied
//     set, and diffing it would leave stale nights behind — which the unique index
//     would then report as a conflict with the booking itself.

const reservationColumns = `id, tenant_id, unit_id, guest_name, guest_phone, guest_email,
	check_in_date, check_out_date, adults, children, status,
	booking_kind, monthly_rate_minor, meter_readings,
	nightly_rate_minor, accommodation_minor, services_minor, total_minor,
	prepaid_minor, deposit_minor, deposit_status, notes, actual_check_out_date,
	conflict_code, conflict_details, created_at, updated_at, deleted_at, version, last_writer`

func scanReservation(row rowScanner) (*Reservation, error) {
	var reservation Reservation
	err := row.Scan(
		&reservation.ID, &reservation.TenantID, &reservation.UnitID,
		&reservation.GuestName, &reservation.GuestPhone, &reservation.GuestEmail,
		&reservation.CheckInDate, &reservation.CheckOutDate,
		&reservation.Adults, &reservation.Children, &reservation.Status,
		&reservation.BookingKind, &reservation.MonthlyRateMinor, &reservation.MeterReadings,
		&reservation.NightlyRateMinor, &reservation.AccommodationMinor,
		&reservation.ServicesMinor, &reservation.TotalMinor,
		&reservation.PrepaidMinor, &reservation.DepositMinor, &reservation.DepositStatus,
		&reservation.Notes, &reservation.ActualCheckOutDate,
		&reservation.ConflictCode, &reservation.ConflictDetails,
		&reservation.CreatedAt, &reservation.UpdatedAt, &reservation.DeletedAt,
		&reservation.Version, &reservation.LastWriter,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &reservation, nil
}

// ListReservations returns the tenant's bookings, newest first, with their child rows.
func (s *Store) ListReservations(ctx context.Context, tenantID string) ([]Reservation, error) {
	var reservations []Reservation
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+reservationColumns+`
			FROM reservations WHERE deleted_at IS NULL ORDER BY check_in_date DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			reservation, err := scanReservation(rows)
			if err != nil {
				return err
			}
			reservations = append(reservations, *reservation)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(reservations) == 0 {
			return nil
		}

		// Child rows are loaded in three set-based queries rather than one per
		// reservation: a busy month would otherwise issue hundreds of round trips.
		ids := make([]string, 0, len(reservations))
		index := make(map[string]*Reservation, len(reservations))
		for i := range reservations {
			ids = append(ids, reservations[i].ID)
			index[reservations[i].ID] = &reservations[i]
		}
		return loadReservationChildren(ctx, tx, ids, index)
	})
	if err != nil {
		return nil, err
	}
	return reservations, nil
}

// GetReservation loads one booking with its child rows.
func (s *Store) GetReservation(ctx context.Context, tenantID, reservationID string) (*Reservation, error) {
	var reservation *Reservation
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		var err error
		reservation, err = scanReservation(tx.QueryRow(ctx,
			`SELECT `+reservationColumns+` FROM reservations WHERE id = $1 AND deleted_at IS NULL`,
			reservationID))
		if err != nil {
			return err
		}
		index := map[string]*Reservation{reservation.ID: reservation}
		return loadReservationChildren(ctx, tx, []string{reservation.ID}, index)
	})
	if err != nil {
		return nil, err
	}
	return reservation, nil
}

// loadReservationChildren fills Nights, Services and Meals for the given ids.
func loadReservationChildren(
	ctx context.Context,
	tx pgx.Tx,
	ids []string,
	index map[string]*Reservation,
) error {
	nightRows, err := tx.Query(ctx, `
		SELECT id, reservation_id, unit_id, night_date
		FROM reservation_nights
		WHERE reservation_id = ANY($1) AND deleted_at IS NULL
		ORDER BY night_date`, ids)
	if err != nil {
		return err
	}
	for nightRows.Next() {
		var night ReservationNight
		if err := nightRows.Scan(&night.ID, &night.ReservationID, &night.UnitID, &night.NightDate); err != nil {
			nightRows.Close()
			return err
		}
		if parent, ok := index[night.ReservationID]; ok {
			parent.Nights = append(parent.Nights, night)
		}
	}
	nightRows.Close()
	if err := nightRows.Err(); err != nil {
		return err
	}

	serviceRows, err := tx.Query(ctx, `
		SELECT id, reservation_id, service_type, service_name, unit_price_minor, quantity
		FROM reservation_services
		WHERE reservation_id = ANY($1) AND deleted_at IS NULL
		ORDER BY service_type`, ids)
	if err != nil {
		return err
	}
	for serviceRows.Next() {
		var service ReservationService
		if err := serviceRows.Scan(&service.ID, &service.ReservationID, &service.ServiceType, &service.ServiceName,
			&service.UnitPriceMinor, &service.Quantity); err != nil {
			serviceRows.Close()
			return err
		}
		if parent, ok := index[service.ReservationID]; ok {
			parent.Services = append(parent.Services, service)
		}
	}
	serviceRows.Close()
	if err := serviceRows.Err(); err != nil {
		return err
	}

	mealRows, err := tx.Query(ctx, `
		SELECT id, reservation_id, meal_date, meal_type, amount_minor
		FROM reservation_meals
		WHERE reservation_id = ANY($1) AND deleted_at IS NULL
		ORDER BY meal_date, meal_type`, ids)
	if err != nil {
		return err
	}
	defer mealRows.Close()
	for mealRows.Next() {
		var meal ReservationMeal
		if err := mealRows.Scan(&meal.ID, &meal.ReservationID, &meal.MealDate,
			&meal.MealType, &meal.AmountMinor); err != nil {
			return err
		}
		if parent, ok := index[meal.ReservationID]; ok {
			parent.Meals = append(parent.Meals, meal)
		}
	}
	return mealRows.Err()
}

// CreateReservation inserts a booking and its whole child graph atomically.
//
// A night that is already taken aborts the transaction and is reported as a combined
// conflict, which the HTTP layer turns into a 409. The pre-check in the service layer
// produces the friendlier message; the unique index catches the race.
func (s *Store) CreateReservation(ctx context.Context, tenantID string, input *domain.ReservationInput, writer string) (*Reservation, error) {
	id, err := NewID()
	if err != nil {
		return nil, err
	}

	var reservation *Reservation
	err = s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		// The unit must belong to this tenant and be usable.
		//
		// The foreign key alone does NOT enforce this: it only requires that SOME unit
		// with that id exists, so without this check tenant B could create a booking
		// against tenant A's unit. RLS would keep the row inside B's tenant, which is
		// precisely what makes the bug quiet — B's calendar would show a booking on a
		// unit it does not own, and A's unit would appear double-booked to nobody.
		//
		// Checking here rather than only in the service layer means no caller can skip
		// it, including the sync path.
		if err := assertUnitBookable(ctx, tx, tenantID, input.UnitID); err != nil {
			return err
		}

		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}

		// Default to a stay when the caller did not say: an older client that omits the
		// field must not create an untyped row.
		kind := string(input.Kind)
		if kind == "" {
			kind = string(domain.KindStay)
		}
		// An empty reading set is `{}`, never NULL: the column is NOT NULL and a NULL
		// would make every later read need a nil check for no benefit.
		meterReadings := []byte("{}")
		if len(input.MeterReadings) > 0 {
			encoded, err := json.Marshal(input.MeterReadings)
			if err != nil {
				return fmt.Errorf("encode meter readings: %w", err)
			}
			meterReadings = encoded
		}

		reservation, err = scanReservation(tx.QueryRow(ctx, `
			INSERT INTO reservations(
				id, tenant_id, unit_id, guest_name, guest_phone, guest_email,
				check_in_date, check_out_date, adults, children, status,
				booking_kind, monthly_rate_minor, meter_readings,
				nightly_rate_minor, accommodation_minor, services_minor, total_minor,
				prepaid_minor, deposit_minor, deposit_status, notes,
				actual_check_out_date, version, last_writer)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
			RETURNING `+reservationColumns,
			id, tenantID, input.UnitID, input.GuestName, input.GuestPhone, input.GuestEmail,
			input.CheckIn, input.CheckOut, input.Adults, input.Children, string(input.Status),
			kind, input.MonthlyRateMinor, meterReadings,
			input.NightlyRateMinor, input.AccommodationMinor, input.ServicesMinor, input.TotalMinor,
			input.PrepaidMinor, input.DepositMinor, string(input.DepositStatus), input.Notes,
			input.ActualCheckOut, version, writer))
		if err != nil {
			return err
		}

		if err := writeReservationChildren(ctx, tx, tenantID, reservation.ID, input, version, writer); err != nil {
			return err
		}
		if err := s.audit(ctx, tx, tenantID, "reservation", reservation.ID, "create", writer); err != nil {
			return err
		}

		// Re-read so the response carries the nights and meals that were just written,
		// rather than the input the caller already has.
		index := map[string]*Reservation{reservation.ID: reservation}
		return loadReservationChildren(ctx, tx, []string{reservation.ID}, index)
	})
	if err != nil {
		return nil, TranslateError(err)
	}
	return reservation, nil
}

// UpdateReservation replaces a booking and regenerates its child graph.
func (s *Store) UpdateReservation(ctx context.Context, tenantID, reservationID string, input *domain.ReservationInput, writer string) (*Reservation, error) {
	var reservation *Reservation
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		if err := assertUnitBookable(ctx, tx, tenantID, input.UnitID); err != nil {
			return err
		}

		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}

		reservation, err = scanReservation(tx.QueryRow(ctx, `
			UPDATE reservations SET
				unit_id = $2, guest_name = $3, guest_phone = $4, guest_email = $5,
				check_in_date = $6, check_out_date = $7, adults = $8, children = $9,
				status = $10, nightly_rate_minor = $11, accommodation_minor = $12,
				services_minor = $13, total_minor = $14, prepaid_minor = $15,
				deposit_minor = $16, deposit_status = $17, notes = $18,
				actual_check_out_date = $19, updated_at = now(),
				version = $20, last_writer = $21
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING `+reservationColumns,
			reservationID, input.UnitID, input.GuestName, input.GuestPhone, input.GuestEmail,
			input.CheckIn, input.CheckOut, input.Adults, input.Children, string(input.Status),
			input.NightlyRateMinor, input.AccommodationMinor, input.ServicesMinor, input.TotalMinor,
			input.PrepaidMinor, input.DepositMinor, string(input.DepositStatus), input.Notes,
			input.ActualCheckOut, version, writer))
		if err != nil {
			return err
		}

		// Child rows are replaced wholesale. The old nights must be released BEFORE the
		// new ones are inserted: the unique index is partial on deleted_at IS NULL, so
		// inserting first would collide with the stay's own previous nights.
		if err := clearReservationChildren(ctx, tx, reservationID, version, writer); err != nil {
			return err
		}
		if err := writeReservationChildren(ctx, tx, tenantID, reservationID, input, version, writer); err != nil {
			return err
		}
		if err := s.audit(ctx, tx, tenantID, "reservation", reservationID, "update", writer); err != nil {
			return err
		}

		index := map[string]*Reservation{reservation.ID: reservation}
		return loadReservationChildren(ctx, tx, []string{reservationID}, index)
	})
	if err != nil {
		return nil, TranslateError(err)
	}
	return reservation, nil
}

// assertUnitBookable verifies that a unit belongs to the tenant and is active.
//
// Errors are deliberately indistinguishable between "no such unit", "another tenant's
// unit" and "archived": a caller must not be able to probe for the existence of
// another tenant's unit ids by comparing error messages.
func assertUnitBookable(ctx context.Context, tx pgx.Tx, tenantID, unitID string) error {
	var status string
	err := tx.QueryRow(ctx, `
		SELECT status FROM units
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
		unitID, tenantID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnitNotBookable
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return ErrUnitNotBookable
	}
	return nil
}

// ErrUnitNotBookable reports that the requested unit cannot accept a booking for this
// tenant. It covers a missing unit, another tenant's unit, and an archived one.
var ErrUnitNotBookable = errors.New("store: unit is not bookable")

// writeReservationChildren inserts nights, services and meals for a reservation.
func writeReservationChildren(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, reservationID string,
	input *domain.ReservationInput,
	version int64,
	writer string,
) error {
	for _, night := range input.Nights {
		nightID, err := NewID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO reservation_nights(id, tenant_id, reservation_id, unit_id, night_date, version, last_writer)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			nightID, tenantID, reservationID, input.UnitID, night, version, writer); err != nil {
			return err
		}
	}

	// Services are aggregated per meal type: one row per type with a quantity, which is
	// what the desktop's calendar and invoice views read.
	type mealAggregate struct {
		unitPrice int64
		quantity  int
	}
	byType := map[domain.MealType]mealAggregate{}
	for _, meal := range input.Meals {
		entry := byType[meal.Type]
		entry.unitPrice = meal.AmountMinor
		entry.quantity++
		byType[meal.Type] = entry

		mealID, err := NewID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO reservation_meals(id, tenant_id, reservation_id, meal_date, meal_type, amount_minor, version, last_writer)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			mealID, tenantID, reservationID, meal.Date, string(meal.Type), meal.AmountMinor,
			version, writer); err != nil {
			return err
		}
	}
	for mealType, entry := range byType {
		serviceID, err := NewID()
		if err != nil {
			return err
		}
		// The label is stored as the type code, not a human string.
		//
		// Services are DERIVED here from the meals already on the booking, so there is no
		// account-chosen name to copy. Storing "breakfast" rather than "Завтрак" keeps one
		// value that the interface translates for the chosen language, instead of baking one
		// language into the row. A name that arrived through the cutover is a real
		// account-authored label and is preserved as-is.
		if _, err := tx.Exec(ctx, `
			INSERT INTO reservation_services(id, tenant_id, reservation_id, service_type, service_name, unit_price_minor, quantity, version, last_writer)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			serviceID, tenantID, reservationID, string(mealType), string(mealType), entry.unitPrice, entry.quantity,
			version, writer); err != nil {
			return err
		}
	}
	return nil
}

// clearReservationChildren soft-deletes a reservation's child rows.
//
// Soft rather than hard, for the same reason as the parent: replicas learn about
// removals from tombstones, and the partial unique indexes only stop enforcing a row
// once deleted_at is set, which is what frees the dates for a rebooking.
func clearReservationChildren(ctx context.Context, tx pgx.Tx, reservationID string, version int64, writer string) error {
	for _, table := range []string{"reservation_nights", "reservation_services", "reservation_meals"} {
		if _, err := tx.Exec(ctx, fmt.Sprintf(`
			UPDATE %s SET deleted_at = now(), updated_at = now(), version = $2, last_writer = $3
			WHERE reservation_id = $1 AND deleted_at IS NULL`, table),
			reservationID, version, writer); err != nil {
			return err
		}
	}
	return nil
}

// CancelReservation marks a booking cancelled and releases its nights.
//
// Releasing the nights is the point: a cancelled booking must free its dates
// immediately, and the nights table is what the overlap index enforces. The row itself
// stays so the history and any payments remain visible.
func (s *Store) CancelReservation(ctx context.Context, tenantID, reservationID, writer string) (*Reservation, error) {
	var reservation *Reservation
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		reservation, err = scanReservation(tx.QueryRow(ctx, `
			UPDATE reservations SET status = $2, updated_at = now(), version = $3, last_writer = $4
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING `+reservationColumns,
			reservationID, string(domain.StatusCancelled), version, writer))
		if err != nil {
			return err
		}
		if err := clearReservationChildren(ctx, tx, reservationID, version, writer); err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "reservation", reservationID, "cancel", writer)
	})
	if err != nil {
		return nil, TranslateError(err)
	}
	return reservation, nil
}

// DeleteReservation soft-deletes a booking. The caller must have cancelled it first;
// that rule is enforced in the service layer so the message can explain why.
func (s *Store) DeleteReservation(ctx context.Context, tenantID, reservationID, writer string) error {
	return s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE reservations SET deleted_at = now(), updated_at = now(), version = $3, last_writer = $4
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
			reservationID, tenantID, version, writer)
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if err := clearReservationChildren(ctx, tx, reservationID, version, writer); err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "reservation", reservationID, "delete", writer)
	})
}

// TakenNights reports which of the given dates are already occupied for a unit.
//
// The caller uses this to produce a helpful message naming the conflicting dates. It is
// advisory only: the unique index decides, because between this query and the insert
// another request can take the same night.
func (s *Store) TakenNights(ctx context.Context, tenantID, unitID string, nights []domain.Date) ([]domain.Date, error) {
	if len(nights) == 0 {
		return nil, nil
	}
	var taken []domain.Date
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT night_date FROM reservation_nights
			WHERE unit_id = $1 AND deleted_at IS NULL AND night_date = ANY($2)
			ORDER BY night_date`, unitID, nights)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var night domain.Date
			if err := rows.Scan(&night); err != nil {
				return err
			}
			taken = append(taken, night)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return taken, nil
}

// NightsConflictError builds the client-facing overlap error.
func NightsConflictError(taken []domain.Date) error {
	rendered := make([]string, 0, len(taken))
	for _, night := range taken {
		rendered = append(rendered, night.String())
	}
	return &ConflictError{Dates: taken, Message: "На указанные даты дом уже занят другой бронью: " + strings.Join(rendered, ", ")}
}

// ConflictError reports that a stay collides with an existing booking.
type ConflictError struct {
	Dates   []domain.Date
	Message string
}

func (e *ConflictError) Error() string { return e.Message }

// Package store — models.
//
// These types mirror the database rows. They are deliberately plain structs with
// no database or HTTP tags: the store returns them, and the HTTP layer decides
// how to present them. Keeping JSON tags out of here is what allows the same row
// to be rendered as a sync payload, an admin view, and a public API object
// without the three drifting apart.
package store

import (
	"time"

	"github.com/inajaf/dombook/server/internal/domain"
)

// Date is a calendar date. Re-exported so callers of this package can name a date
// without importing domain as well; the type is identical, so the two packages agree
// on what a date is rather than each having its own.
type Date = domain.Date

// AccountPlan is a subscription tier. The database constrains the stored values.
type AccountPlan string

const (
	PlanFree     AccountPlan = "free"
	PlanPro      AccountPlan = "pro"
	PlanBusiness AccountPlan = "business"
)

// Known reports whether the plan is one this server understands. An unknown
// stored value is treated as the most restrictive plan rather than trusted.
func (p AccountPlan) Known() bool {
	switch p {
	case PlanFree, PlanPro, PlanBusiness:
		return true
	}
	return false
}

// Effective returns the plan to apply when enforcing limits, falling back to the
// free tier for anything unrecognized. Failing closed is the point: a corrupted
// or future plan value must not be read as "unlimited".
func (p AccountPlan) Effective() AccountPlan {
	if p.Known() {
		return p
	}
	return PlanFree
}

// UserRole is an identity's permission level inside an account.
type UserRole string

const (
	RoleOwner UserRole = "owner"
	RoleAdmin UserRole = "admin"
	RoleStaff UserRole = "staff"
)

// CanManageInvites reports whether the role may invite or revoke users.
func (r UserRole) CanManageInvites() bool {
	return r == RoleOwner || r == RoleAdmin
}

// CanManageBilling reports whether the role may change the plan.
func (r UserRole) CanManageBilling() bool {
	return r == RoleOwner
}

// BookingPolicyConfig is the per-account booking window as stored in
// accounts.booking_policy.
//
// It uses pointer fields so that "not specified" is distinguishable from "zero".
// That distinction matters: a partial update that omits maximumAdvanceDays must
// not silently set it to 0, which would forbid every booking.
type BookingPolicyConfig struct {
	MaximumAdvanceDays *int `json:"maximumAdvanceDays,omitempty"`
	MaximumStayMonths  *int `json:"maximumStayMonths,omitempty"`
	// MaximumTenancyMonths bounds a long-term let, separately from a stay.
	MaximumTenancyMonths *int    `json:"maximumTenancyMonths,omitempty"`
	TimeZone             *string `json:"timeZone,omitempty"`
}

// Account is one tenant: a guest-house business.
type Account struct {
	ID            string
	Name          string
	Plan          AccountPlan
	BookingPolicy BookingPolicyConfig
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// User is an authenticated identity.
type User struct {
	ID        string
	AccountID string
	Email     string
	Name      string
	Role      UserRole
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Device is a registered client installation. Devices can be revoked
// individually, which is what makes "I lost my laptop" a recoverable situation
// without rotating every credential in the account.
type Device struct {
	ID         string
	AccountID  string
	UserID     string
	Name       string
	Platform   string
	LastSyncAt *time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// RefreshToken is a rotating long-lived credential. Only the hash is stored.
type RefreshToken struct {
	ID         string
	AccountID  string
	UserID     string
	DeviceID   *string
	TokenHash  string
	ExpiresAt  time.Time
	UsedAt     *time.Time
	ReplacedBy *string
	RevokedAt  *time.Time
	CreatedAt  time.Time
}

// Invite is a pending invitation to join an account.
type Invite struct {
	ID        string
	AccountID string
	Email     string
	Role      UserRole
	TokenHash string
	CreatedBy string
	Status    string
	ExpiresAt time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

// TenantState is the per-tenant sync watermark. Version is server-monotonic and
// deliberately independent of wall-clock time, so device clock skew cannot
// influence sync ordering.
type TenantState struct {
	TenantID  string
	Version   int64
	UpdatedAt time.Time
}

// Session is an issued access token's server-side record. Revoking the row
// invalidates the JWT before its natural expiry.
type Session struct {
	ID        string
	UserID    string
	AccountID string
	DeviceID  *string
	ExpiresAt time.Time
	RevokedAt *time.Time
	CreatedAt time.Time
}

// ---------------------------------------------------------------------------
// Domain rows
// ---------------------------------------------------------------------------

// Place is a guest house: a group of bookable units sharing a location.
type Place struct {
	ID                  string
	TenantID            string
	Name                string
	Address             string
	HasFoodService      bool
	BreakfastPriceMinor int64
	LunchPriceMinor     int64
	DinnerPriceMinor    int64
	Status              string
	Notes               string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	DeletedAt           *time.Time
	Version             int64
	LastWriter          string
}

// Unit is a bookable cottage or standalone house. It is the licensing unit: the
// free plan caps the number of active units, not places.
type Unit struct {
	ID             string
	TenantID       string
	PlaceID        *string
	Kind           string
	Name           string
	Location       string
	Capacity       int
	BasePriceMinor int64
	DepositMinor   int64
	// MonthlyRateMinor is the rent for a long-term let. Zero means the unit is not
	// offered for rent, which is what the Rentals screen filters on — a separate
	// availability flag could disagree with the price and offer a let with no rate.
	MonthlyRateMinor int64
	Currency         string
	CheckInTime      string
	CheckOutTime     string
	Status           string
	Notes            string
	CreatedAt        time.Time
	UpdatedAt        time.Time
	DeletedAt        *time.Time
	Version          int64
	LastWriter       string
}

// Reservation is a booking, with its child rows loaded.
type Reservation struct {
	ID           string
	TenantID     string
	UnitID       string
	GuestName    string
	GuestPhone   string
	GuestEmail   string
	CheckInDate  Date
	CheckOutDate Date
	Adults       int
	Children     int
	Status       string
	// BookingKind is "stay" or "rental". A tenancy is a reservation with a long date
	// range, which is what lets the single exclusion constraint keep both modes from
	// overlapping.
	BookingKind      string
	MonthlyRateMinor int64
	// MeterReadings holds the utility readings for a tenancy, e.g.
	// {"electricity": {"start": 1200, "end": 1340}}. jsonb because the set of
	// utilities varies by building.
	MeterReadings      []byte
	NightlyRateMinor   int64
	AccommodationMinor int64
	ServicesMinor      int64
	TotalMinor         int64
	PrepaidMinor       int64
	DepositMinor       int64
	DepositStatus      string
	Notes              string
	// ActualCheckOutDate is set after an early departure. It truncates meal
	// eligibility while the accommodation total stays as charged.
	ActualCheckOutDate *Date
	// ConflictCode and ConflictDetails are set when an offline push could not be
	// applied because it collides with an existing stay. The booking is preserved for
	// an admin to resolve rather than rejected.
	ConflictCode    *string
	ConflictDetails []byte
	CreatedAt       time.Time
	UpdatedAt       time.Time
	DeletedAt       *time.Time
	Version         int64
	LastWriter      string

	Nights   []ReservationNight
	Services []ReservationService
	Meals    []ReservationMeal
}

// ReservationNight is one occupied night of a stay.
type ReservationNight struct {
	ID            string
	ReservationID string
	UnitID        string
	NightDate     Date
}

// ReservationService is a priced service line (meals by type).
type ReservationService struct {
	ID            string
	ReservationID string
	ServiceType   string
	// ServiceName is what the guest sees on the invoice. Not derivable from ServiceType: an
	// account may name the same service however it likes.
	ServiceName    string
	UnitPriceMinor int64
	Quantity       int
}

// ReservationMeal is one meal on one night.
type ReservationMeal struct {
	ID            string
	ReservationID string
	MealDate      Date
	MealType      string
	AmountMinor   int64
}

package domain

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Validation errors carry a stable code so clients can branch on the cause without
// parsing localized prose. This mirrors the booking-policy codes in policy.go and is
// what lets the JSON fixtures be shared with the desktop implementation.
const (
	CodeValidation        = "validation_error"
	CodeRequired          = "required"
	CodeTooLong           = "too_long"
	CodeNotAnInteger      = "not_an_integer"
	CodeOutOfRange        = "out_of_range"
	CodeInvalidDate       = "invalid_date"
	CodeDatesOutOfOrder   = "dates_out_of_order"
	CodeStayTooManyNights = "stay_too_many_nights"
	CodeCapacityExceeded  = "capacity_exceeded"
	CodeFoodServiceOff    = "food_service_unavailable"
	CodeMealOutsideStay   = "meal_outside_stay"
	CodeMealDuplicate     = "meal_duplicate"
	CodeMealUnknownType   = "meal_unknown_type"
	CodePrepaidTooLarge   = "prepaid_exceeds_total"
	CodeDepositMissing    = "deposit_amount_required"
	CodeUnknownStatus     = "unknown_status"

	// Rental-specific codes. Stable, like the rest: clients branch on these and
	// sync reports them as conflict reasons.
	CodeInvalidBookingKind    = "invalid_booking_kind"
	CodeRentalTooShort        = "rental_too_short"
	CodeRentalMealsNotAllowed = "rental_meals_not_allowed"
	CodeRentalTooLong         = "rental_too_long"
)

// FieldError is a rejected input field. Field names the offending key so a client
// can highlight it, which is the difference between a usable form error and a
// message the user has to interpret.
type FieldError struct {
	Code    string
	Field   string
	Message string
}

func (e *FieldError) Error() string { return e.Message }

// AsFieldError extracts a *FieldError from err, if present.
func AsFieldError(err error) (*FieldError, bool) {
	var fieldErr *FieldError
	if errors.As(err, &fieldErr) {
		return fieldErr, true
	}
	return nil, false
}

// Limits for free-text fields. These are part of the API contract: the desktop client
// enforces the same maxima, and a mismatch would let the client accept input the
// server then rejects.
const (
	MaxPlaceNameLength = 140
	MaxUnitNameLength  = 120
	MaxGuestNameLength = 160
	MaxAddressLength   = 240
	MaxLocationLength  = 200
	MaxEmailLength     = 200
	MaxNotesLength     = 2000
	MaxCurrencyLength  = 3
	MaxPhoneLength     = 32
	// MaxNightCount bounds how many nights one booking may occupy, and therefore how
	// many reservation_nights rows it materialises.
	//
	// It must stay above the longest term the booking policy permits, or a policy-valid
	// tenancy would be refused for a reason the policy never mentions. The default
	// MaximumTenancyMonths is 24, and the longest possible 24 calendar months span 731
	// days — two 31-day months plus 29 February — so a 730 cap would have rejected
	// exactly the longest legal lease. 1096 covers three years with the slack to spare.
	MaxNightCount         = 1096
	MaxMealItems          = 2190
	MaxCurrencyMinorUnits = 1_000_000_000
	MaxCapacity           = 100
)

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// RequiredText trims, requires non-empty, and bounds the length.
func RequiredText(value any, field, label string, max int) (string, error) {
	result := strings.TrimSpace(toString(value))
	if result == "" {
		return "", &FieldError{
			Code:    CodeRequired,
			Field:   field,
			Message: fmt.Sprintf("%s: обязательное поле", label),
		}
	}
	// Counted in runes, not bytes: a 140-character Cyrillic name is 280 bytes, and a
	// byte-based limit would reject names the desktop client accepts.
	if len([]rune(result)) > max {
		return "", &FieldError{
			Code:    CodeTooLong,
			Field:   field,
			Message: fmt.Sprintf("%s: максимум %d символов", label, max),
		}
	}
	return result, nil
}

// OptionalText trims and bounds the length, allowing empty.
func OptionalText(value any, field, label string, max int) (string, error) {
	result := strings.TrimSpace(toString(value))
	if len([]rune(result)) > max {
		return "", &FieldError{
			Code:    CodeTooLong,
			Field:   field,
			Message: fmt.Sprintf("%s: максимум %d символов", label, max),
		}
	}
	return result, nil
}

// Integer parses an integer in [min, max].
//
// It rejects fractional input rather than truncating: a nightly rate of 24000.50 is
// a client bug, and silently charging 24000 would hide it. It also rejects values
// arriving as JSON floats with no fractional part only after checking, so 24000.0 is
// accepted while 24000.5 is not.
func Integer(value any, field, label string, min, max int) (int, error) {
	number, ok := toInt(value)
	if !ok {
		return 0, &FieldError{
			Code:    CodeNotAnInteger,
			Field:   field,
			Message: fmt.Sprintf("%s: укажите целое число от %d до %d", label, min, max),
		}
	}
	if number < min || number > max {
		return 0, &FieldError{
			Code:    CodeOutOfRange,
			Field:   field,
			Message: fmt.Sprintf("%s: укажите целое число от %d до %d", label, min, max),
		}
	}
	return number, nil
}

// Money parses a non-negative amount in minor units.
//
// Money is an integer count of minor units everywhere — never a float. Accumulating
// floats would produce totals that disagree with the client's by a cent, which is
// exactly the kind of discrepancy a booking system cannot afford.
func Money(value any, field, label string) (int64, error) {
	number, ok := toInt(value)
	if !ok || number < 0 {
		return 0, &FieldError{
			Code:    CodeNotAnInteger,
			Field:   field,
			Message: fmt.Sprintf("%s: укажите целое неотрицательное число", label),
		}
	}
	if number > MaxCurrencyMinorUnits {
		return 0, &FieldError{
			Code:    CodeOutOfRange,
			Field:   field,
			Message: fmt.Sprintf("%s: максимум %d", label, MaxCurrencyMinorUnits),
		}
	}
	return int64(number), nil
}

// ValidDate parses a strict YYYY-MM-DD calendar date.
//
// Strict on purpose: "2026-8-1" and "2026-08-01" naming the same night must not both
// be accepted, or sync payloads from different clients would produce duplicate rows
// for one stay.
func ValidDate(value any, field, label string) (Date, error) {
	result := strings.TrimSpace(toString(value))
	parsed, err := ParseDate(result)
	if err != nil {
		return Date{}, &FieldError{
			Code:    CodeInvalidDate,
			Field:   field,
			Message: fmt.Sprintf("%s: неверная дата", label),
		}
	}
	// ParseDate already rejects overflowing days, but comparing the round trip
	// catches input like "2026-02-30" that a lenient parser might normalize.
	if parsed.String() != result {
		return Date{}, &FieldError{
			Code:    CodeInvalidDate,
			Field:   field,
			Message: fmt.Sprintf("%s: неверная дата", label),
		}
	}
	return parsed, nil
}

// NormalizePhone keeps digits and a leading plus, bounded in length.
//
// Phone numbers are stored normalized so that "050-123-45-67" and "+994501234567"
// can be matched; the raw form is not preserved because nothing displays it.
func NormalizePhone(value any) string {
	var builder strings.Builder
	for _, r := range toString(value) {
		if unicode.IsDigit(r) || (r == '+' && builder.Len() == 0) {
			builder.WriteRune(r)
		}
	}
	result := builder.String()
	if len(result) > MaxPhoneLength {
		result = result[:MaxPhoneLength]
	}
	return result
}

// Nights returns every occupied night in [checkIn, checkOut).
func Nights(checkIn, checkOut Date) ([]Date, error) {
	if !checkOut.After(checkIn) {
		return nil, &FieldError{
			Code:    CodeDatesOutOfOrder,
			Field:   "checkOutDate",
			Message: "Дата выезда должна быть позже даты заезда",
		}
	}
	count := checkIn.NightsBetween(checkOut)
	// Bounded before allocating: an unvalidated range could otherwise ask for
	// millions of entries and exhaust memory before any limit check ran.
	if count > MaxNightCount {
		return nil, &FieldError{
			Code:    CodeStayTooManyNights,
			Field:   "checkOutDate",
			Message: fmt.Sprintf("Бронирование не может быть длиннее %d ночей", MaxNightCount),
		}
	}
	return checkIn.EachNight(checkOut), nil
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

// ReservationStatus is the lifecycle state of a booking.
type ReservationStatus string

const (
	StatusHold       ReservationStatus = "hold"
	StatusConfirmed  ReservationStatus = "confirmed"
	StatusCheckedIn  ReservationStatus = "checked_in"
	StatusCheckedOut ReservationStatus = "checked_out"
	StatusCancelled  ReservationStatus = "cancelled"
	StatusNoShow     ReservationStatus = "no_show"
	// StatusConflict marks an offline booking the server could not apply because it
	// collides with an existing stay. The row is preserved for an admin to resolve
	// rather than rejected, so no guest's booking silently disappears.
	StatusConflict ReservationStatus = "conflict"
)

// Occupies reports whether a status holds its dates.
//
// This must match the WHERE clause of the exclusion constraint in
// migrations/20260811000002_security.sql. If the two disagree, a status that occupies
// dates here but not there could be double-booked, or vice versa.
func (s ReservationStatus) Occupies() bool {
	switch s {
	case StatusHold, StatusConfirmed, StatusCheckedIn:
		return true
	}
	return false
}

// ValidStatuses are the statuses a client may set directly. `conflict` is excluded:
// it is assigned by the sync engine, and a client claiming it could hide a real
// double-booking from the admin queue.
var ValidStatuses = []ReservationStatus{
	StatusHold, StatusConfirmed, StatusCheckedIn, StatusCheckedOut, StatusCancelled, StatusNoShow,
}

// ParseReservationStatus validates a client-supplied status, defaulting to hold.
func ParseReservationStatus(value any) ReservationStatus {
	candidate := ReservationStatus(strings.TrimSpace(toString(value)))
	for _, allowed := range ValidStatuses {
		if candidate == allowed {
			return candidate
		}
	}
	return StatusHold
}

// BookingKind distinguishes a nightly stay from a long-term tenancy.
//
// A tenancy is NOT a separate entity: it is a reservation with a long date range.
// That is what lets the single exclusion constraint on reservations enforce
// availability across both modes — a tenancy blocks short stays and is blocked by
// them, with no second availability check that could drift out of step.
//
// The kind is stored rather than derived from the length. An owner may agree a
// monthly rate on a three-month let, and deriving the kind would then flip that
// tenancy into a stay the moment its term was edited below the threshold.
type BookingKind string

const (
	// KindStay is a nightly booking. The default, and what every existing row is.
	KindStay BookingKind = "stay"
	// KindRental is a tenancy priced by the month.
	KindRental BookingKind = "rental"
)

// ValidBookingKinds are the kinds a client may set directly.
var ValidBookingKinds = []BookingKind{KindStay, KindRental}

// ParseBookingKind validates a client-supplied kind, defaulting to a stay.
//
// Defaulting rather than erroring on an unknown value keeps an older client that
// does not send the field working, which is the same reason the column default is
// 'stay'. An explicit nonsense value is caught by validation instead.
func ParseBookingKind(value any) BookingKind {
	candidate := BookingKind(strings.TrimSpace(toString(value)))
	for _, allowed := range ValidBookingKinds {
		if candidate == allowed {
			return candidate
		}
	}
	return KindStay
}

// IsKnownBookingKind reports whether a value names a kind this build understands.
//
// Separate from ParseBookingKind because the two answer different questions: this
// one rejects a typo, the other supplies a default for a missing field.
func IsKnownBookingKind(kind BookingKind) bool {
	for _, allowed := range ValidBookingKinds {
		if kind == allowed {
			return true
		}
	}
	return false
}

// DepositStatus tracks the security deposit.
type DepositStatus string

const (
	DepositNone              DepositStatus = "none"
	DepositDue               DepositStatus = "due"
	DepositReceived          DepositStatus = "received"
	DepositReturned          DepositStatus = "returned"
	DepositPartiallyWithheld DepositStatus = "partially_withheld"
	DepositWithheld          DepositStatus = "withheld"
)

// ValidDepositStatuses are the statuses a client may set directly.
var ValidDepositStatuses = []DepositStatus{
	DepositNone, DepositDue, DepositReceived, DepositReturned,
	DepositPartiallyWithheld, DepositWithheld,
}

// ParseDepositStatus validates a client-supplied deposit status, defaulting to none.
func ParseDepositStatus(value any) DepositStatus {
	candidate := DepositStatus(strings.TrimSpace(toString(value)))
	for _, allowed := range ValidDepositStatuses {
		if candidate == allowed {
			return candidate
		}
	}
	return DepositNone
}

// MealType identifies a meal service.
type MealType string

const (
	MealBreakfast MealType = "breakfast"
	MealLunch     MealType = "lunch"
	MealDinner    MealType = "dinner"
)

// ValidMealTypes are the meal services the system prices.
var ValidMealTypes = []MealType{MealBreakfast, MealLunch, MealDinner}

// ParseMealType validates a meal type.
func ParseMealType(value any) (MealType, error) {
	candidate := MealType(strings.TrimSpace(toString(value)))
	for _, allowed := range ValidMealTypes {
		if candidate == allowed {
			return candidate, nil
		}
	}
	return "", &FieldError{
		Code:    CodeMealUnknownType,
		Field:   "mealItems",
		Message: "Питание: неизвестный тип",
	}
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

func toString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case bool:
		// Only reachable through a mis-shaped payload; treated as empty so the
		// caller reports a validation error rather than inserting "true".
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

// toInt converts a JSON number or numeric string to an int, rejecting fractional
// values and anything outside the exact-integer range.
func toInt(value any) (int, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		// JSON decodes every number as float64. A value with a fractional part is
		// not a valid minor-unit amount, and truncating it would hide a client bug.
		if typed != float64(int64(typed)) {
			return 0, false
		}
		return int(typed), true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

// FormatDate renders a Date as the wire format.
func FormatDate(date Date) string { return date.String() }

// ParseDateField is a convenience wrapper for callers that already know the value is
// a date string.
func ParseDateField(value string) (Date, error) { return ValidDate(value, "date", "Дата") }

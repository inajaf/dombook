// Package domain holds DomBook's business rules: booking windows, stay
// pricing, and plan quotas. It imports no database and no HTTP, so the same
// rules can be exercised directly by tests and reused by any transport.
//
// These rules are implemented a second time in JavaScript for the desktop and
// web clients (src/domain/booking/booking-policy.cjs). Both implementations are
// pinned to fixtures/*.json; a rule change that is not accompanied by a fixture
// change will fail one of the two suites.
package domain

import (
	"errors"
	"fmt"
	"time"
)

// Stable error codes for booking-window violations. Codes are part of the API
// contract (clients branch on them, and sync reports them in conflicts);
// messages are localized prose and may change freely.
const (
	CodeCheckInPast   = "check_in_past"
	CodeCheckInTooFar = "check_in_too_far"
	CodeStayTooLong   = "stay_too_long"
)

// DefaultPolicy is the shipped booking policy, applied to every account that
// has not overridden it. It must stay equal to BOOKING_POLICY in
// src/domain/booking/booking-policy.cjs and to the accounts.booking_policy
// column default, or clients and server will disagree about what is bookable.
var DefaultPolicy = Policy{
	MaximumAdvanceDays: 21,
	MaximumStayMonths:  3,
	TimeZone:           "Asia/Baku",
}

// Policy is one account's booking window rules. It is stored per account
// (accounts.booking_policy) so an owner can widen or narrow the window without
// a code change.
type Policy struct {
	// MaximumAdvanceDays bounds how far ahead a check-in may be booked.
	MaximumAdvanceDays int
	// MaximumStayMonths bounds the length of a stay in calendar months.
	MaximumStayMonths int
	// TimeZone decides which calendar day "today" is.
	TimeZone string
}

// WithDefaults fills unset fields from DefaultPolicy. A zero MaximumAdvanceDays
// would otherwise forbid every booking, so an incomplete stored policy must not
// silently become a lockout.
func (p Policy) WithDefaults() Policy {
	if p.MaximumAdvanceDays <= 0 {
		p.MaximumAdvanceDays = DefaultPolicy.MaximumAdvanceDays
	}
	if p.MaximumStayMonths <= 0 {
		p.MaximumStayMonths = DefaultPolicy.MaximumStayMonths
	}
	if p.TimeZone == "" {
		p.TimeZone = DefaultPolicy.TimeZone
	}
	return p
}

// Validate reports whether the policy is usable. Rejecting a bad override at
// the edge beats discovering at booking time that a timezone is unknown.
func (p Policy) Validate() error {
	if p.MaximumAdvanceDays <= 0 {
		return errors.New("maximumAdvanceDays must be positive")
	}
	if p.MaximumStayMonths <= 0 {
		return errors.New("maximumStayMonths must be positive")
	}
	if p.TimeZone == "" {
		return errors.New("timeZone is required")
	}
	if _, err := time.LoadLocation(p.TimeZone); err != nil {
		return fmt.Errorf("unknown timeZone %q", p.TimeZone)
	}
	return nil
}

// Violation is a rejected booking window. Code is stable and machine-readable;
// Message is user-facing Russian prose matching the desktop wording.
type Violation struct {
	Code    string
	Message string
}

func (v *Violation) Error() string { return v.Message }

// AsViolation extracts a *Violation from err, if present.
func AsViolation(err error) (*Violation, bool) {
	var v *Violation
	if errors.As(err, &v) {
		return v, true
	}
	return nil, false
}

// Limits is the resolved booking window for a given check-in date. Clients
// display these so a user sees the boundary before submitting.
type Limits struct {
	Today               Date
	MaximumCheckInDate  Date
	MaximumCheckOutDate Date
	MaximumAdvanceDays  int
	MaximumStayMonths   int
	TimeZone            string
}

// TodayInTimeZone returns the current calendar date in the policy timezone.
// "Today" is deliberately never taken from the host clock's local zone: the
// server may run in UTC while the business operates in Asia/Baku, and a booking
// made at 23:00 local must not be judged as the next day.
func TodayInTimeZone(now time.Time, timeZone string) (Date, error) {
	loc, err := time.LoadLocation(timeZone)
	if err != nil {
		return Date{}, fmt.Errorf("unknown timeZone %q", timeZone)
	}
	local := now.In(loc)
	return Date{year: local.Year(), month: local.Month(), day: local.Day()}, nil
}

// LimitsFor resolves the booking window anchored on checkInDate.
func (p Policy) LimitsFor(checkInDate Date, today Date) Limits {
	return Limits{
		Today:               today,
		MaximumCheckInDate:  today.AddDays(p.MaximumAdvanceDays),
		MaximumCheckOutDate: checkInDate.AddCalendarMonths(p.MaximumStayMonths),
		MaximumAdvanceDays:  p.MaximumAdvanceDays,
		MaximumStayMonths:   p.MaximumStayMonths,
		TimeZone:            p.TimeZone,
	}
}

// ExistingBooking carries the stored dates of the reservation being updated, so
// an edit that does not touch the stay is not re-validated. Without this,
// editing a two-year-old booking would fail because its dates are in the past.
type ExistingBooking struct {
	CheckIn  Date
	CheckOut Date
}

// AssertBookingDates validates a stay against the policy.
//
// The check order and the "skip when unchanged" rule are part of the contract
// with the desktop client and are pinned by fixtures/booking-policy-cases.json.
// In particular the two date checks are individually guarded:
//
//   - past / too-far apply only when check-in changed, so an unchanged past
//     check-in is never re-rejected;
//   - the maximum stay is evaluated whenever the stay is re-validated, because
//     a moved check-out can lengthen a stay even when check-in is untouched.
//
// Passing a nil existing booking means "new reservation".
func (p Policy) AssertBookingDates(
	checkInDate, checkOutDate Date,
	today Date,
	existing *ExistingBooking,
) error {
	checkInChanged := existing == nil || existing.CheckIn != checkInDate
	checkOutChanged := existing == nil || existing.CheckOut != checkOutDate
	if !checkInChanged && !checkOutChanged {
		return nil
	}

	limits := p.LimitsFor(checkInDate, today)

	if checkInChanged && checkInDate.Before(limits.Today) {
		return &Violation{
			Code:    CodeCheckInPast,
			Message: "Дата заезда не может быть в прошлом",
		}
	}
	if checkInChanged && checkInDate.After(limits.MaximumCheckInDate) {
		return &Violation{
			Code: CodeCheckInTooFar,
			Message: fmt.Sprintf(
				"Заезд можно оформить максимум на %d день вперёд — до %s",
				p.MaximumAdvanceDays, limits.MaximumCheckInDate,
			),
		}
	}
	if checkOutDate.After(limits.MaximumCheckOutDate) {
		return &Violation{
			Code: CodeStayTooLong,
			Message: fmt.Sprintf(
				"Проживание не может быть дольше %d календарных месяцев — выезд не позже %s",
				p.MaximumStayMonths, limits.MaximumCheckOutDate,
			),
		}
	}
	return nil
}

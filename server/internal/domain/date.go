package domain

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"time"
)

// Date is a calendar date with no time-of-day and no timezone. Booking rules
// are defined over calendar dates ("2026-08-11"), so representing them as
// time.Time would reintroduce exactly the zone ambiguity the policy exists to
// remove: a stay must not change meaning depending on where it is read.
//
// The zero Date is invalid; construct with ParseDate.
type Date struct {
	year  int
	month time.Month
	day   int
}

// IsoLayout is the wire format for every calendar date in the API and sync
// protocol.
const IsoLayout = "2006-01-02"

// ParseDate parses a YYYY-MM-DD calendar date. It is deliberately strict:
// ParseDate("2026-8-1") is an error rather than a silent normalization, because
// sync payloads come from other implementations and a lenient parser would
// accept "2026-8-1" and "2026-08-01" as the same night while a strict one
// catches the divergence.
func ParseDate(value string) (Date, error) {
	t, err := time.Parse(IsoLayout, value)
	if err != nil {
		return Date{}, fmt.Errorf("invalid date %q: want YYYY-MM-DD", value)
	}
	return Date{year: t.Year(), month: t.Month(), day: t.Day()}, nil
}

// MustParseDate is for tests and constant literals only.
func MustParseDate(value string) Date {
	d, err := ParseDate(value)
	if err != nil {
		panic(err)
	}
	return d
}

// String returns the canonical YYYY-MM-DD form.
func (d Date) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.year, int(d.month), d.day)
}

// IsZero reports whether d is the zero value, which is never a valid date.
func (d Date) IsZero() bool { return d == Date{} }

// Before reports whether d is strictly earlier than other.
func (d Date) Before(other Date) bool { return d.String() < other.String() }

// After reports whether d is strictly later than other.
func (d Date) After(other Date) bool { return d.String() > other.String() }

// AddCalendarMonths adds whole months, clamping the day to the target month's
// last day. Clamping matters: 2026-01-31 + 1 month is 2026-02-28, not
// 2026-03-03. Go's time.Date normalizes an overflowing day into the next month,
// so the clamp must be applied explicitly. This mirrors addCalendarMonths() in
// src/domain/booking/booking-policy.cjs and is pinned by
// fixtures/date-math-cases.json.
func (d Date) AddCalendarMonths(months int) Date {
	// Land on the first of the target month, then clamp: this reads the target
	// month's real length even when the source day does not exist there.
	first := time.Date(d.year, d.month+time.Month(months), 1, 0, 0, 0, 0, time.UTC)
	// Day 0 of the following month is the last day of the target month.
	lastDay := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	day := d.day
	if day > lastDay {
		day = lastDay
	}
	return Date{year: first.Year(), month: first.Month(), day: day}
}

// AddDays adds whole days, rolling across month and year boundaries.
func (d Date) AddDays(days int) Date {
	t := time.Date(d.year, d.month, d.day, 0, 0, 0, 0, time.UTC).AddDate(0, 0, days)
	return Date{year: t.Year(), month: t.Month(), day: t.Day()}
}

// WholeMonthsBetween returns how many whole calendar months fit from d to other.
//
// It is the inverse of AddCalendarMonths: the result is the largest n for which
// d.AddCalendarMonths(n) does not pass other. So 2026-01-15 -> 2026-04-15 is 3,
// and 2026-01-15 -> 2026-04-14 is 2, because a rent month is only complete when
// its day-of-month is reached.
//
// Days are deliberately NOT divided by 30: that would make February cheaper than
// January, and it would disagree with the month-end clamping AddCalendarMonths
// already applies. Going through the clamp is also what makes 2026-01-31 ->
// 2026-02-28 a whole month — the shortest expression of "one month later" from
// 31 January is 28 February, so by the inverse definition that month is complete.
//
// Rent for a tenancy is computed from this, so the definition is a pricing rule,
// not a formatting detail. It is mirrored in src/domain/booking/booking-policy.cjs
// and pinned by fixtures/rental-terms-cases.json.
//
// Negative when other precedes d. The count is always taken from the EARLIER date
// and the sign applied afterwards, which keeps the result antisymmetric: a
// one-day span is 0 months whichever way round it is asked, rather than -0 in one
// direction and 0 in the other.
func (d Date) WholeMonthsBetween(other Date) int {
	if other.Before(d) {
		// The negation is of a non-negative count, so no sign normalisation is
		// needed here: an int has no negative zero. The JS mirror does need one,
		// which is why it normalises explicitly.
		return -wholeMonthsForward(other, d)
	}
	return wholeMonthsForward(d, other)
}

// wholeMonthsForward counts whole months from an earlier-or-equal date to a later
// one, using the same clamping AddCalendarMonths applies.
func wholeMonthsForward(from, to Date) int {
	// A month difference computed from the year/month fields is an upper bound;
	// adding it can overshoot because of day-of-month, so step back while it does.
	months := (to.year-from.year)*12 + int(to.month) - int(from.month)
	if months < 0 {
		// Later date in an earlier month number, e.g. 2026-12-31 -> 2027-01-01:
		// the span is under a month, so zero is the right answer.
		months = 0
	}
	for months > 0 && from.AddCalendarMonths(months).After(to) {
		months--
	}
	return months
}

// NightsBetween returns the number of nights from d to other. A stay from the
// 11th to the 14th is 3 nights. Negative when other precedes d.
func (d Date) NightsBetween(other Date) int {
	from := time.Date(d.year, d.month, d.day, 0, 0, 0, 0, time.UTC)
	to := time.Date(other.year, other.month, other.day, 0, 0, 0, 0, time.UTC)
	return int(to.Sub(from).Hours() / 24)
}

// EachNight yields every night in [d, end) — the check-out day is not occupied,
// matching reservation_nights generation and the Postgres exclusion constraint
// daterange(check_in, check_out, '[)').
func (d Date) EachNight(end Date) []Date {
	nights := d.NightsBetween(end)
	if nights <= 0 {
		return nil
	}
	out := make([]Date, 0, nights)
	for i := 0; i < nights; i++ {
		out = append(out, d.AddDays(i))
	}
	return out
}

// ---------------------------------------------------------------------------
// Database mapping
// ---------------------------------------------------------------------------

// Scan implements sql.Scanner so a PostgreSQL `date` maps onto Date directly.
//
// Without this, every query would have to select the column as text or scan into a
// time.Time and convert, and each call site would be a chance to introduce a timezone
// mistake. PostgreSQL's date has no timezone, which is exactly what Date models.
func (d *Date) Scan(value any) error {
	switch typed := value.(type) {
	case nil:
		// A NULL date is not representable; a Date is a value, not a nullable field.
		// Callers that allow NULL must scan into a *Date instead.
		return errors.New("cannot scan NULL into domain.Date; use *domain.Date for nullable columns")
	case time.Time:
		*d = Date{year: typed.Year(), month: typed.Month(), day: typed.Day()}
		return nil
	case string:
		parsed, err := ParseDate(typed)
		if err != nil {
			return err
		}
		*d = parsed
		return nil
	case []byte:
		parsed, err := ParseDate(string(typed))
		if err != nil {
			return err
		}
		*d = parsed
		return nil
	default:
		return fmt.Errorf("cannot scan %T into domain.Date", value)
	}
}

// Value implements driver.Valuer so Date can be bound as a query parameter.
func (d Date) Value() (driver.Value, error) {
	if d.IsZero() {
		return nil, errors.New("cannot store the zero domain.Date; construct one with ParseDate")
	}
	return d.String(), nil
}

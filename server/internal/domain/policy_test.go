package domain

import (
	"encoding/json"
	"testing"
	"time"
)

// TestEmbeddedFixturesMatchCanonical guards the one copy step in the fixture
// pipeline. fixtures/*.json at the repository root is the source of truth, but
// //go:embed cannot reference a parent directory, so the files are duplicated
// into testdata/. Without this test the duplicate could silently rot and the Go
// suite would pass against stale expectations while the JS suite used the new
// ones — exactly the drift the shared-fixture scheme exists to prevent.
//
// jsonEqual compares parsed values rather than bytes so that reformatting the
// canonical file does not fail the build; only a semantic change does.
func TestEmbeddedFixturesMatchCanonical(t *testing.T) {
	for _, name := range []string{
		"booking-policy-cases.json",
		"date-math-cases.json",
		"plan-limit-cases.json",
	} {
		t.Run(name, func(t *testing.T) {
			embedded := readFixture(t, name)
			canonical := readCanonicalFixture(t, name)

			var want, got any
			if err := json.Unmarshal(canonical, &want); err != nil {
				t.Fatalf("canonical %s is not valid JSON: %v", name, err)
			}
			if err := json.Unmarshal(embedded, &got); err != nil {
				t.Fatalf("embedded %s is not valid JSON: %v", name, err)
			}
			if !jsonEqual(want, got) {
				t.Fatalf("fixtures/%s and internal/domain/testdata/%s have diverged; "+
					"re-copy with: cp fixtures/*.json server/internal/domain/testdata/", name, name)
			}
		})
	}
}

func jsonEqual(a, b any) bool {
	encodedA, errA := json.Marshal(a)
	encodedB, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return false
	}
	return string(encodedA) == string(encodedB)
}

// --- booking policy ---------------------------------------------------------

type policyFixture struct {
	Op     string           `json:"op"`
	Policy PolicyFixtureDef `json:"policy"`
	Cases  []policyCase     `json:"cases"`
}

type PolicyFixtureDef struct {
	MaximumAdvanceDays int    `json:"maximumAdvanceDays"`
	MaximumStayMonths  int    `json:"maximumStayMonths"`
	TimeZone           string `json:"timeZone"`
}

type policyCase struct {
	Name                string `json:"name"`
	Today               string `json:"today"`
	CheckInDate         string `json:"checkInDate"`
	CheckOutDate        string `json:"checkOutDate"`
	ExistingReservation *struct {
		CheckIn  string `json:"check_in_date"`
		CheckOut string `json:"check_out_date"`
	} `json:"existingReservation"`
	Expect struct {
		OK   bool   `json:"ok"`
		Code string `json:"code"`
	} `json:"expect"`
}

func loadPolicyFixture(t *testing.T) policyFixture {
	t.Helper()
	var fixture policyFixture
	if err := json.Unmarshal(readFixture(t, "booking-policy-cases.json"), &fixture); err != nil {
		t.Fatalf("decode booking-policy-cases.json: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("booking-policy-cases.json has no cases")
	}
	return fixture
}

// TestAssertBookingDatesAgainstFixtures pins the ported booking window rules to
// the same expectations the JavaScript client is held to. Error codes — not
// localized messages — are asserted, so wording stays a presentation concern.
func TestAssertBookingDatesAgainstFixtures(t *testing.T) {
	fixture := loadPolicyFixture(t)
	policy := Policy{
		MaximumAdvanceDays: fixture.Policy.MaximumAdvanceDays,
		MaximumStayMonths:  fixture.Policy.MaximumStayMonths,
		TimeZone:           fixture.Policy.TimeZone,
	}

	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			today := MustParseDate(testCase.Today)
			checkIn := MustParseDate(testCase.CheckInDate)
			checkOut := MustParseDate(testCase.CheckOutDate)

			var existing *ExistingBooking
			if testCase.ExistingReservation != nil {
				existing = &ExistingBooking{
					CheckIn:  MustParseDate(testCase.ExistingReservation.CheckIn),
					CheckOut: MustParseDate(testCase.ExistingReservation.CheckOut),
				}
			}

			err := policy.AssertBookingDates(checkIn, checkOut, today, existing)

			if testCase.Expect.OK {
				if err != nil {
					t.Fatalf("expected the stay to be accepted, got %v", err)
				}
				return
			}

			if err == nil {
				t.Fatalf("expected rejection with code %q, but the stay was accepted", testCase.Expect.Code)
			}
			violation, ok := AsViolation(err)
			if !ok {
				t.Fatalf("expected a *Violation, got %T: %v", err, err)
			}
			if violation.Code != testCase.Expect.Code {
				t.Fatalf("got code %q, want %q (message: %s)",
					violation.Code, testCase.Expect.Code, violation.Message)
			}
		})
	}
}

// --- date math --------------------------------------------------------------

type dateMathCase struct {
	Op     string          `json:"op"`
	Date   string          `json:"date"`
	Days   int             `json:"days"`
	Months int             `json:"months"`
	Expect json.RawMessage `json:"expect"`
}

func loadDateMathCases(t *testing.T) []dateMathCase {
	t.Helper()
	var wrapper struct {
		Cases []dateMathCase `json:"cases"`
	}
	if err := json.Unmarshal(readFixture(t, "date-math-cases.json"), &wrapper); err != nil {
		t.Fatalf("decode date-math-cases.json: %v", err)
	}
	if len(wrapper.Cases) == 0 {
		t.Fatal("date-math-cases.json has no cases")
	}
	return wrapper.Cases
}

// TestDateMathAgainstFixtures covers the two primitives every booking and
// pricing computation is built on. Month-end clamping is the subtle case: Go's
// time.Date normalizes an overflowing day into the following month, whereas the
// JavaScript reference clamps, so the days must be pinned rather than assumed.
func TestDateMathAgainstFixtures(t *testing.T) {
	for _, testCase := range loadDateMathCases(t) {
		name := testCase.Op + " " + testCase.Date
		t.Run(name, func(t *testing.T) {
			date := MustParseDate(testCase.Date)

			switch testCase.Op {
			case "addDaysIso":
				var want string
				if err := json.Unmarshal(testCase.Expect, &want); err != nil {
					t.Fatalf("expect is not a string: %v", err)
				}
				if got := date.AddDays(testCase.Days).String(); got != want {
					t.Fatalf("AddDays(%d) = %s, want %s", testCase.Days, got, want)
				}

			case "addCalendarMonths":
				var want string
				if err := json.Unmarshal(testCase.Expect, &want); err != nil {
					t.Fatalf("expect is not a string: %v", err)
				}
				if got := date.AddCalendarMonths(testCase.Months).String(); got != want {
					t.Fatalf("AddCalendarMonths(%d) = %s, want %s", testCase.Months, got, want)
				}

			case "bookingLimits":
				var want struct {
					MaximumCheckInDate  string `json:"maximumCheckInDate"`
					MaximumCheckOutDate string `json:"maximumCheckOutDate"`
					MaximumAdvanceDays  int    `json:"maximumAdvanceDays"`
					MaximumStayMonths   int    `json:"maximumStayMonths"`
					TimeZone            string `json:"timeZone"`
				}
				if err := json.Unmarshal(testCase.Expect, &want); err != nil {
					t.Fatalf("expect is not a limits object: %v", err)
				}
				got := DefaultPolicy.LimitsFor(date, date)
				if got.MaximumCheckInDate.String() != want.MaximumCheckInDate {
					t.Errorf("MaximumCheckInDate = %s, want %s", got.MaximumCheckInDate, want.MaximumCheckInDate)
				}
				if got.MaximumCheckOutDate.String() != want.MaximumCheckOutDate {
					t.Errorf("MaximumCheckOutDate = %s, want %s", got.MaximumCheckOutDate, want.MaximumCheckOutDate)
				}
				if got.MaximumAdvanceDays != want.MaximumAdvanceDays {
					t.Errorf("MaximumAdvanceDays = %d, want %d", got.MaximumAdvanceDays, want.MaximumAdvanceDays)
				}
				if got.MaximumStayMonths != want.MaximumStayMonths {
					t.Errorf("MaximumStayMonths = %d, want %d", got.MaximumStayMonths, want.MaximumStayMonths)
				}
				if got.TimeZone != want.TimeZone {
					t.Errorf("TimeZone = %q, want %q", got.TimeZone, want.TimeZone)
				}

			default:
				t.Fatalf("unknown op %q in date-math-cases.json", testCase.Op)
			}
		})
	}
}

// TestTodayInTimeZoneUsesPolicyZone verifies "today" follows the policy zone,
// not the host zone. A server in UTC judging a 23:30 Baku booking would
// otherwise see the previous day and reject a valid check-in.
func TestTodayInTimeZoneUsesPolicyZone(t *testing.T) {
	// 2026-08-11T20:30:00Z is already 2026-08-12 00:30 in Asia/Baku (UTC+4).
	instant := time.Date(2026, 8, 11, 20, 30, 0, 0, time.UTC)

	baku, err := TodayInTimeZone(instant, "Asia/Baku")
	if err != nil {
		t.Fatalf("TodayInTimeZone: %v", err)
	}
	if got, want := baku.String(), "2026-08-12"; got != want {
		t.Errorf("Asia/Baku today = %s, want %s", got, want)
	}

	utc, err := TodayInTimeZone(instant, "UTC")
	if err != nil {
		t.Fatalf("TodayInTimeZone: %v", err)
	}
	if got, want := utc.String(), "2026-08-11"; got != want {
		t.Errorf("UTC today = %s, want %s", got, want)
	}

	if _, err := TodayInTimeZone(instant, "Not/AZone"); err == nil {
		t.Error("expected an error for an unknown timezone")
	}
}

// TestNightsBetweenAndEachNight pins the half-open stay semantics that the
// Postgres exclusion constraint daterange(check_in, check_out, '[)') relies on.
// The check-out day is not occupied, so back-to-back stays must not collide.
func TestNightsBetweenAndEachNight(t *testing.T) {
	checkIn := MustParseDate("2026-08-11")
	checkOut := MustParseDate("2026-08-14")

	if got, want := checkIn.NightsBetween(checkOut), 3; got != want {
		t.Errorf("NightsBetween = %d, want %d", got, want)
	}

	nights := checkIn.EachNight(checkOut)
	if len(nights) != 3 {
		t.Fatalf("EachNight returned %d nights, want 3", len(nights))
	}
	wantNights := []string{"2026-08-11", "2026-08-12", "2026-08-13"}
	for i, want := range wantNights {
		if got := nights[i].String(); got != want {
			t.Errorf("night %d = %s, want %s", i, got, want)
		}
	}

	// The check-out day itself is free for the next guest.
	if got, want := checkIn.EachNight(checkOut)[2].AddDays(1).String(), "2026-08-14"; got != want {
		t.Errorf("last night + 1 = %s, want %s", got, want)
	}

	// A zero-length or inverted stay occupies nothing rather than erroring:
	// callers validate dates first, and panicking here would turn a validation
	// failure into a 500.
	if nights := checkIn.EachNight(checkIn); nights != nil {
		t.Errorf("EachNight on an empty stay = %v, want nil", nights)
	}
	if nights := checkOut.EachNight(checkIn); nights != nil {
		t.Errorf("EachNight on an inverted stay = %v, want nil", nights)
	}
}

// TestPolicyFailsClosedOnInvalidOverride guards the configuration path. A policy
// stored with a zero window would make every date invalid, so such a policy must
// be rejected at write time rather than at booking time.
func TestPolicyFailsClosedOnInvalidOverride(t *testing.T) {
	if err := DefaultPolicy.Validate(); err != nil {
		t.Fatalf("DefaultPolicy must be valid, got %v", err)
	}

	invalid := []struct {
		name   string
		policy Policy
	}{
		{"zero advance days", Policy{MaximumAdvanceDays: 0, MaximumStayMonths: 3, TimeZone: "Asia/Baku"}},
		{"negative advance days", Policy{MaximumAdvanceDays: -1, MaximumStayMonths: 3, TimeZone: "Asia/Baku"}},
		{"zero stay months", Policy{MaximumAdvanceDays: 21, MaximumStayMonths: 0, TimeZone: "Asia/Baku"}},
		{"empty timezone", Policy{MaximumAdvanceDays: 21, MaximumStayMonths: 3, TimeZone: ""}},
		{"unknown timezone", Policy{MaximumAdvanceDays: 21, MaximumStayMonths: 3, TimeZone: "Mars/Olympus"}},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			if err := testCase.policy.Validate(); err == nil {
				t.Error("expected Validate to reject this policy")
			}
		})
	}

	// WithDefaults repairs partial policies instead of locking the account out.
	repaired := Policy{}.WithDefaults()
	if err := repaired.Validate(); err != nil {
		t.Errorf("WithDefaults produced an invalid policy: %v", err)
	}
	if repaired != DefaultPolicy {
		t.Errorf("WithDefaults = %+v, want %+v", repaired, DefaultPolicy)
	}
}

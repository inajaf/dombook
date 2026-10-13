package domain

import (
	"encoding/json"
	"testing"
)

// Rental-term fixture tests.
//
// wholeMonthsBetween decides what a tenancy costs, so it is a pricing rule rather
// than a formatting helper. Both stacks must agree exactly: the desktop computes
// rent while offline and the server recomputes it on push, so a disagreement of one
// month is a customer billed differently depending on which device they used.
//
// These cases all come from fixtures/rental-terms-cases.json. Adding an assertion
// here instead of to the fixture would create a rule only the server enforces.

type rentalTermCase struct {
	Op               string `json:"op"`
	From             string `json:"from"`
	To               string `json:"to"`
	Expect           int64  `json:"expect"`
	MonthlyRateMinor int64  `json:"monthlyRateMinor"`
}

func loadRentalTermCases(t *testing.T) []rentalTermCase {
	t.Helper()
	var fixture struct {
		Cases []rentalTermCase `json:"cases"`
	}
	if err := json.Unmarshal(readFixture(t, "rental-terms-cases.json"), &fixture); err != nil {
		t.Fatalf("parse rental-terms-cases.json: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("the rental fixture has no cases, so these tests would prove nothing")
	}
	return fixture.Cases
}

func TestWholeMonthsBetweenAgainstFixture(t *testing.T) {
	seen := 0
	for _, testCase := range loadRentalTermCases(t) {
		if testCase.Op != "wholeMonthsBetween" {
			continue
		}
		seen++
		from, err := ParseDate(testCase.From)
		if err != nil {
			t.Fatalf("bad from date %q: %v", testCase.From, err)
		}
		to, err := ParseDate(testCase.To)
		if err != nil {
			t.Fatalf("bad to date %q: %v", testCase.To, err)
		}

		got := from.WholeMonthsBetween(to)
		if int64(got) != testCase.Expect {
			t.Errorf("%s -> %s: got %d, want %d", testCase.From, testCase.To, got, testCase.Expect)
		}

		// Antisymmetry is a property, not a case: one fixture entry cannot express
		// it, and a mirroring bug (returning 0 one way and -1 the other for a
		// sub-month span) would otherwise pass every case above.
		if reverse := to.WholeMonthsBetween(from); reverse != -got {
			t.Errorf("%s/%s is not antisymmetric: %d and %d", testCase.From, testCase.To, got, reverse)
		}
	}
	if seen == 0 {
		t.Fatal("no wholeMonthsBetween cases were exercised")
	}
}

// TestRentForAgainstFixture pins the money, not just the month count. A month
// count that is right for the wrong reason would still produce a wrong invoice.
func TestRentForAgainstFixture(t *testing.T) {
	seen := 0
	for _, testCase := range loadRentalTermCases(t) {
		if testCase.Op != "rentFor" {
			continue
		}
		seen++

		from, err := ParseDate(testCase.From)
		if err != nil {
			t.Fatalf("bad from date %q: %v", testCase.From, err)
		}
		to, err := ParseDate(testCase.To)
		if err != nil {
			t.Fatalf("bad to date %q: %v", testCase.To, err)
		}

		months := from.WholeMonthsBetween(to)
		if months < 0 {
			t.Fatalf("%s -> %s is backwards; the fixture should only price forward terms", testCase.From, testCase.To)
		}
		got := int64(months) * testCase.MonthlyRateMinor
		if got != testCase.Expect {
			t.Errorf("%s -> %s at %d/month: got %d, want %d",
				testCase.From, testCase.To, testCase.MonthlyRateMinor, got, testCase.Expect)
		}
	}
	if seen == 0 {
		t.Fatal("no rentFor cases were exercised")
	}
}

// TestWholeMonthsBetweenNeverOvershoots states the defining property directly: the
// answer is the LARGEST month count that does not pass the end date, and the next
// one does. Asserting the bound rather than a table catches a case nobody thought
// to write down.
func TestWholeMonthsBetweenNeverOvershoots(t *testing.T) {
	start := MustParseDate("2026-01-31")
	for days := 0; days <= 800; days++ {
		end := start.AddDays(days)
		months := start.WholeMonthsBetween(end)

		if months < 0 {
			t.Fatalf("a forward span produced %d months at +%d days", months, days)
		}
		if landed := start.AddCalendarMonths(months); landed.After(end) {
			t.Fatalf("+%d days: %d months overshoots to %s, past %s", days, months, landed, end)
		}
		if landed := start.AddCalendarMonths(months + 1); !landed.After(end) {
			t.Fatalf("+%d days: %d months does not overshoot (%s is not past %s), so the count is too low",
				days, months+1, landed, end)
		}
	}
}

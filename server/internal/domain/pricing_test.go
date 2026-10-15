package domain

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

// What a booking costs, against the cases both stacks share.
//
// The expectations live in fixtures/pricing-cases.json and are asserted here AND in JavaScript
// (tests/pricing.test.cjs). The server prices a booking as well as storing one — a reservation
// arriving over the REST API is recomputed from the unit's rates — so a client charging a season
// rate the server does not know about would have its booking silently repriced.

type pricingFixture struct {
	BaseNightlyRateMinor int64            `json:"baseNightlyRateMinor"`
	MonthlyRateMinor     int64            `json:"monthlyRateMinor"`
	Rules                json.RawMessage  `json:"rules"`
	Quotes               []pricingCase    `json:"quotes"`
	Validation           []validationCase `json:"validation"`
}

type pricingCase struct {
	Name  string `json:"name"`
	Input struct {
		Kind                 string          `json:"kind"`
		CheckInDate          string          `json:"checkInDate"`
		CheckOutDate         string          `json:"checkOutDate"`
		BaseNightlyRateMinor *int64          `json:"baseNightlyRateMinor"`
		MonthlyRateMinor     *int64          `json:"monthlyRateMinor"`
		RateRules            json.RawMessage `json:"rateRules"`
	} `json:"input"`
	Expect struct {
		Nights                *int        `json:"nights"`
		Lines                 []QuoteLine `json:"lines"`
		Months                *int        `json:"months"`
		MonthlyRateMinor      *int64      `json:"monthlyRateMinor"`
		EffectiveMonthlyMinor *int64      `json:"effectiveMonthlyMinor"`
		GrossMinor            *int64      `json:"grossMinor"`
		DiscountPercent       *float64    `json:"discountPercent"`
		DiscountMinor         *int64      `json:"discountMinor"`
		TotalMinor            *int64      `json:"totalMinor"`
	} `json:"expect"`
}

type validationCase struct {
	Name   string          `json:"name"`
	Rules  json.RawMessage `json:"rules"`
	Expect []string        `json:"expect"`
}

func loadPricingFixture(t *testing.T) pricingFixture {
	t.Helper()
	var fixture pricingFixture
	if err := json.Unmarshal(readFixture(t, "pricing-cases.json"), &fixture); err != nil {
		t.Fatalf("parse pricing fixture: %v", err)
	}
	return fixture
}

// rulesFor turns the case's own rule set into the canonical JSON text the production code paths
// accept. A case that names none is asserting the baseline behaviour, so the fixture's rules
// apply; a case that names null is asserting a unit with no rules at all.
func rulesFor(t *testing.T, raw json.RawMessage, fallback json.RawMessage) string {
	t.Helper()
	if len(raw) == 0 {
		raw = fallback
	}
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	// A JSON string is a stored rule set that happens to be unreadable — the case that proves a
	// corrupt row still prices at the base rate.
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	return string(raw)
}

func TestQuoteReservationCases(t *testing.T) {
	fixture := loadPricingFixture(t)
	for _, testCase := range fixture.Quotes {
		t.Run(testCase.Name, func(t *testing.T) {
			checkIn := MustParseDate(testCase.Input.CheckInDate)
			checkOut := MustParseDate(testCase.Input.CheckOutDate)
			base := fixture.BaseNightlyRateMinor
			if testCase.Input.BaseNightlyRateMinor != nil {
				base = *testCase.Input.BaseNightlyRateMinor
			}
			monthly := fixture.MonthlyRateMinor
			if testCase.Input.MonthlyRateMinor != nil {
				monthly = *testCase.Input.MonthlyRateMinor
			}
			rules := ParseRateRules(rulesFor(t, testCase.Input.RateRules, fixture.Rules))
			quote := QuoteReservation(BookingKind(testCase.Input.Kind), checkIn, checkOut, base, monthly, rules)

			expect := testCase.Expect
			if expect.Nights != nil && quote.Nights != *expect.Nights {
				t.Errorf("nights = %d, want %d", quote.Nights, *expect.Nights)
			}
			if expect.Months != nil && quote.Months != *expect.Months {
				t.Errorf("months = %d, want %d", quote.Months, *expect.Months)
			}
			if expect.Lines != nil && !reflect.DeepEqual(quote.Lines, expect.Lines) {
				t.Errorf("lines = %+v, want %+v", quote.Lines, expect.Lines)
			}
			if expect.MonthlyRateMinor != nil && quote.MonthlyRateMinor != *expect.MonthlyRateMinor {
				t.Errorf("monthlyRateMinor = %d, want %d", quote.MonthlyRateMinor, *expect.MonthlyRateMinor)
			}
			if expect.EffectiveMonthlyMinor != nil && quote.EffectiveMonthlyMinor != *expect.EffectiveMonthlyMinor {
				t.Errorf("effectiveMonthlyMinor = %d, want %d", quote.EffectiveMonthlyMinor, *expect.EffectiveMonthlyMinor)
			}
			if expect.GrossMinor != nil && quote.GrossMinor != *expect.GrossMinor {
				t.Errorf("grossMinor = %d, want %d", quote.GrossMinor, *expect.GrossMinor)
			}
			if expect.DiscountPercent != nil && math.Abs(quote.DiscountPercent-*expect.DiscountPercent) > 1e-9 {
				t.Errorf("discountPercent = %v, want %v", quote.DiscountPercent, *expect.DiscountPercent)
			}
			if expect.DiscountMinor != nil && quote.DiscountMinor != *expect.DiscountMinor {
				t.Errorf("discountMinor = %d, want %d", quote.DiscountMinor, *expect.DiscountMinor)
			}
			if expect.TotalMinor != nil && quote.TotalMinor != *expect.TotalMinor {
				t.Errorf("totalMinor = %d, want %d", quote.TotalMinor, *expect.TotalMinor)
			}
		})
	}
}

func TestValidateRateRulesCases(t *testing.T) {
	fixture := loadPricingFixture(t)
	for _, testCase := range fixture.Validation {
		t.Run(testCase.Name, func(t *testing.T) {
			got := ValidateRateRules(string(testCase.Rules))
			want := testCase.Expect
			if want == nil {
				want = []string{}
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("ValidateRateRules = %v, want %v", got, want)
			}
		})
	}
}

func TestUnreadableRateRulesFallBackToTheBaseRate(t *testing.T) {
	// Rules travel between devices as JSON text. A half-written row must not take the calendar
	// down with it: refusing the booking would turn an unreadable settings value into a unit
	// nobody can sell.
	for _, broken := range []string{"", "{", "null", "[]", "42", `{"seasons":"нет"}`} {
		rules := ParseRateRules(broken)
		if HasRateRules(rules) {
			t.Errorf("ParseRateRules(%q) produced rules from an unreadable value: %+v", broken, rules)
		}
		quote := QuoteReservation(KindStay, MustParseDate("2026-11-02"), MustParseDate("2026-11-05"), 24000, 0, rules)
		if quote.TotalMinor != 72000 {
			t.Errorf("ParseRateRules(%q): total = %d, want the base rate (72000)", broken, quote.TotalMinor)
		}
	}
}

func TestALongLetIsCheaperPerMonthThanAShortOne(t *testing.T) {
	// The rule the product promises: a long-term let is priced differently from a short one, and
	// the difference is visible as a monthly figure an owner can compare between units.
	rules := ParseRateRules(`{"tenancyDiscounts":[{"minimumMonths":12,"percent":10}]}`)
	short := QuoteReservation(KindRental, MustParseDate("2026-01-31"), MustParseDate("2026-04-30"), 0, 480000, rules)
	long := QuoteReservation(KindRental, MustParseDate("2026-01-31"), MustParseDate("2027-01-31"), 0, 480000, rules)

	if short.EffectiveMonthlyMinor != 480000 {
		t.Errorf("three months effective rate = %d, want the full 480000", short.EffectiveMonthlyMinor)
	}
	if long.EffectiveMonthlyMinor != 432000 {
		t.Errorf("a year effective rate = %d, want 432000 after the 10%% discount", long.EffectiveMonthlyMinor)
	}
	if long.EffectiveMonthlyMinor >= short.EffectiveMonthlyMinor {
		t.Error("a year should not cost the same per month as three months")
	}
}

func TestPercentOfRoundsHalfUp(t *testing.T) {
	// Go's float64 and JavaScript's Number disagree on some .5 boundaries, so both stacks compute
	// the discount in integers. A one-qəpik difference between client and server is still a
	// difference, and it is the kind that only shows up on an invoice.
	cases := []struct {
		amount   int64
		percent  float64
		expected int64
	}{
		{1010, 15, 152},
		{168000, 10, 16800},
		{0, 10, 0},
		{1000, 0, 0},
		{100, 100, 100},
	}
	for _, testCase := range cases {
		if got := percentOf(testCase.amount, testCase.percent); got != testCase.expected {
			t.Errorf("percentOf(%d, %v) = %d, want %d", testCase.amount, testCase.percent, got, testCase.expected)
		}
	}
}

package domain

import "testing"

// Rental booking-window tests.
//
// A tenancy is deliberately exempt from the advance window: that rule stops a guest
// booking a cottage two years out, whereas a residential lease is signed weeks or
// months ahead by design. Applying it would refuse ordinary business, so the
// exemption is the point of these tests rather than a detail of them.

func TestATenancyIgnoresTheAdvanceWindow(t *testing.T) {
	today := MustParseDate("2026-08-11")
	policy := DefaultPolicy

	// Three weeks out, running a year. The advance window is 21 days, so a stay of
	// these dates is refused (asserted below) while the tenancy is accepted.
	checkIn := MustParseDate("2026-09-01")
	checkOut := MustParseDate("2027-09-01")

	if err := policy.AssertBookingDatesFor(KindRental, checkIn, checkOut, today, nil); err != nil {
		t.Fatalf("a 12-month tenancy three weeks out must be accepted: %v", err)
	}

	// The same dates as a stay are refused for length, proving the two kinds are
	// judged by different rules and this is not simply a laxer check.
	err := policy.AssertBookingDatesFor(KindStay, checkIn, checkOut, today, nil)
	if err == nil {
		t.Fatal("the same dates as a stay should be refused by the three-month limit")
	}
	if violation, ok := AsViolation(err); !ok || violation.Code != CodeStayTooLong {
		t.Errorf("stay refusal code = %v, want %s", err, CodeStayTooLong)
	}
}

func TestATenancyIsStillBoundedByItsOwnLength(t *testing.T) {
	today := MustParseDate("2026-08-11")
	policy := DefaultPolicy // 24 months

	// 25 months, starting far enough out that the advance window would also refuse
	// it — so the code proves the tenancy bound applies, not the advance bound.
	checkIn := MustParseDate("2026-09-01")
	checkOut := MustParseDate("2028-10-01")

	err := policy.AssertBookingDatesFor(KindRental, checkIn, checkOut, today, nil)
	if err == nil {
		t.Fatal("a 25-month tenancy should be refused")
	}
	violation, ok := AsViolation(err)
	if !ok {
		t.Fatalf("expected a Violation, got %T: %v", err, err)
	}
	if violation.Code != CodeRentalTooLong {
		t.Errorf("code = %s, want %s", violation.Code, CodeRentalTooLong)
	}
}

func TestATenancyStillRejectsAPastStart(t *testing.T) {
	// Exempting the advance window must not exempt the past: a lease cannot begin
	// before it was signed.
	today := MustParseDate("2026-08-11")
	err := DefaultPolicy.AssertBookingDatesFor(KindRental,
		MustParseDate("2026-08-01"), MustParseDate("2026-11-01"), today, nil)
	if err == nil {
		t.Fatal("a tenancy starting in the past should be refused")
	}
	if violation, ok := AsViolation(err); !ok || violation.Code != CodeCheckInPast {
		t.Errorf("code = %v, want %s", err, CodeCheckInPast)
	}
}

func TestAnUnchangedTenancyStaysEditable(t *testing.T) {
	// A lease signed last year must remain editable without its dates being re-judged,
	// or every tenancy becomes unmaintainable the moment it starts.
	today := MustParseDate("2026-08-11")
	existing := &ExistingBooking{
		CheckIn:  MustParseDate("2024-01-01"),
		CheckOut: MustParseDate("2026-01-01"),
	}
	if err := DefaultPolicy.AssertBookingDatesFor(KindRental,
		MustParseDate("2024-01-01"), MustParseDate("2026-01-01"), today, existing); err != nil {
		t.Fatalf("an unchanged tenancy must stay editable: %v", err)
	}
}

func TestStayBehaviourIsUnchangedByTheRentalExemption(t *testing.T) {
	// The exemption is reached only for KindRental. A stay must still fail the
	// advance window, or the rule has been loosened for everyone.
	today := MustParseDate("2026-08-11")
	err := DefaultPolicy.AssertBookingDatesFor(KindStay,
		MustParseDate("2026-09-20"), MustParseDate("2026-09-22"), today, nil)
	if err == nil {
		t.Fatal("a stay beyond the advance window should still be refused")
	}
	if violation, ok := AsViolation(err); !ok || violation.Code != CodeCheckInTooFar {
		t.Errorf("code = %v, want %s", err, CodeCheckInTooFar)
	}
}

func TestBookingKindParsing(t *testing.T) {
	// An unknown value defaults rather than erroring, so a client that does not send
	// the field keeps working. IsKnownBookingKind is the stricter check for callers
	// that need to reject a typo.
	if got := ParseBookingKind("rental"); got != KindRental {
		t.Errorf("ParseBookingKind(rental) = %q", got)
	}
	if got := ParseBookingKind(""); got != KindStay {
		t.Errorf("an absent kind should default to stay, got %q", got)
	}
	if got := ParseBookingKind("nonsense"); got != KindStay {
		t.Errorf("an unknown kind should default to stay, got %q", got)
	}
	if IsKnownBookingKind(BookingKind("nonsense")) {
		t.Error("IsKnownBookingKind accepted a value that is not a kind")
	}
	if !IsKnownBookingKind(KindRental) {
		t.Error("IsKnownBookingKind rejected rental")
	}
}

func TestMaxNightCountLeavesRoomForTheLongestTenancy(t *testing.T) {
	// The policy bound and the row-materialisation bound must not disagree, or a
	// policy-valid tenancy would be refused for a reason the policy never mentions.
	// The longest possible span of DefaultPolicy.MaximumTenancyMonths calendar
	// months is that many months plus the extra days a shorter starting month adds.
	start := MustParseDate("2026-01-31")
	end := start.AddCalendarMonths(DefaultPolicy.MaximumTenancyMonths)
	nights := start.NightsBetween(end)
	if nights > MaxNightCount {
		t.Errorf("a %d-month tenancy is %d nights, which exceeds MaxNightCount (%d): "+
			"a policy-valid term would be refused by the night cap",
			DefaultPolicy.MaximumTenancyMonths, nights, MaxNightCount)
	}

	// And a 24-month lease beginning in the longest possible position is under it.
	worst := MustParseDate("2027-08-31").AddCalendarMonths(24)
	if span := MustParseDate("2027-08-31").NightsBetween(worst); span > MaxNightCount {
		t.Errorf("the longest 24-month span is %d nights, over the cap of %d", span, MaxNightCount)
	}
}

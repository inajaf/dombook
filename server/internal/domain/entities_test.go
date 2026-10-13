package domain

import (
	"errors"
	"strings"
	"testing"
)

// fieldCode extracts the stable code from a validator error so tests assert on the
// contract rather than on Russian prose.
func fieldCode(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	if fieldErr, ok := AsFieldError(err); ok {
		return fieldErr.Code
	}
	if violation, ok := AsViolation(err); ok {
		return violation.Code
	}
	t.Fatalf("expected a *FieldError or *Violation, got %T: %v", err, err)
	return ""
}

func TestRequiredText(t *testing.T) {
	if _, err := RequiredText("  ", "name", "Имя", 10); fieldCode(t, err) != CodeRequired {
		t.Errorf("blank input should be required, got %v", err)
	}
	if _, err := RequiredText(nil, "name", "Имя", 10); fieldCode(t, err) != CodeRequired {
		t.Errorf("nil should be required, got %v", err)
	}

	got, err := RequiredText("  Лесная долина  ", "name", "Имя", 40)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "Лесная долина" {
		t.Errorf("value = %q, want trimmed", got)
	}
}

// TestLengthLimitsCountRunesNotBytes is the reason the limits are rune-based: a
// 140-character Cyrillic name is 280 bytes, so a byte limit would reject names the
// desktop client accepts — a mismatch the user experiences as "the server broke".
func TestLengthLimitsCountRunesNotBytes(t *testing.T) {
	// Exactly at the limit: 140 Cyrillic characters (280 bytes).
	atLimit := strings.Repeat("я", MaxPlaceNameLength)
	if _, err := RequiredText(atLimit, "name", "Название", MaxPlaceNameLength); err != nil {
		t.Errorf("a value exactly at the limit must be accepted: %v", err)
	}

	overLimit := strings.Repeat("я", MaxPlaceNameLength+1)
	if _, err := RequiredText(overLimit, "name", "Название", MaxPlaceNameLength); fieldCode(t, err) != CodeTooLong {
		t.Errorf("one character over the limit should be rejected, got %v", err)
	}
}

// TestIntegerRejectsFractions guards the money path: minor units are whole numbers, and
// truncating 24000.50 would silently charge a different amount than the client showed.
func TestIntegerRejectsFractions(t *testing.T) {
	if _, err := Integer(24000.5, "price", "Цена", 0, 1_000_000); fieldCode(t, err) != CodeNotAnInteger {
		t.Errorf("a fractional value should be rejected, got %v", err)
	}
	// A whole number arriving as a JSON float is normal and must be accepted.
	if got, err := Integer(24000.0, "price", "Цена", 0, 1_000_000); err != nil || got != 24000 {
		t.Errorf("Integer(24000.0) = %d, %v; want 24000, nil", got, err)
	}
	// Numeric strings appear in form payloads.
	if got, err := Integer("150", "price", "Цена", 0, 1_000_000); err != nil || got != 150 {
		t.Errorf("Integer(\"150\") = %d, %v; want 150, nil", got, err)
	}
	if _, err := Integer("abc", "capacity", "Вместимость", 1, 100); fieldCode(t, err) != CodeNotAnInteger {
		t.Errorf("a non-numeric string should be rejected, got %v", err)
	}
	if _, err := Integer(0, "capacity", "Вместимость", 1, 100); fieldCode(t, err) != CodeOutOfRange {
		t.Errorf("below the minimum should be out of range, got %v", err)
	}
	if _, err := Integer(101, "capacity", "Вместимость", 1, 100); fieldCode(t, err) != CodeOutOfRange {
		t.Errorf("above the maximum should be out of range, got %v", err)
	}
}

func TestMoneyRejectsNegativeAndOversized(t *testing.T) {
	if _, err := Money(-1, "price", "Цена"); fieldCode(t, err) != CodeNotAnInteger {
		t.Errorf("a negative amount should be rejected, got %v", err)
	}
	if _, err := Money(MaxCurrencyMinorUnits+1, "price", "Цена"); fieldCode(t, err) != CodeOutOfRange {
		t.Errorf("an oversized amount should be rejected, got %v", err)
	}
	if got, err := Money(0, "price", "Цена"); err != nil || got != 0 {
		t.Errorf("zero must be allowed: %d, %v", got, err)
	}
}

func TestValidDateIsStrict(t *testing.T) {
	if _, err := ValidDate("2026-08-11", "d", "Дата"); err != nil {
		t.Fatalf("a canonical date should parse: %v", err)
	}
	for _, bad := range []string{
		"2026-8-1",             // unpadded
		"2026-02-30",           // no such day
		"2026-13-01",           // no such month
		"11/08/2026",           // wrong format
		"",                     // empty
		"2026-08-11T00:00:00Z", // timestamp, not a date
	} {
		if _, err := ValidDate(bad, "d", "Дата"); fieldCode(t, err) != CodeInvalidDate {
			t.Errorf("ValidDate(%q) should be rejected, got %v", bad, err)
		}
	}
}

func TestNormalizePhone(t *testing.T) {
	// Spacing and punctuation are stripped; only digits and a leading plus survive.
	for input, want := range map[string]string{
		"+994501234567": "+994501234567",
		"050-123-45-67": "0501234567",
		"(050) 123":     "050123",
		"":              "",
	} {
		if got := NormalizePhone(input); got != want {
			t.Errorf("NormalizePhone(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNightsRejectsInvertedAndUnboundedRanges(t *testing.T) {
	checkIn := MustParseDate("2026-08-11")

	if _, err := Nights(checkIn, MustParseDate("2026-08-11")); fieldCode(t, err) != CodeDatesOutOfOrder {
		t.Errorf("a zero-night stay should be rejected, got %v", err)
	}
	if _, err := Nights(checkIn, MustParseDate("2026-08-10")); fieldCode(t, err) != CodeDatesOutOfOrder {
		t.Errorf("an inverted range should be rejected, got %v", err)
	}

	// Bounded before allocating: an unbounded range must not exhaust memory.
	if _, err := Nights(checkIn, MustParseDate("2036-08-11")); fieldCode(t, err) != CodeStayTooManyNights {
		t.Errorf("a ten-year stay should be rejected, got %v", err)
	}

	nights, err := Nights(checkIn, MustParseDate("2026-08-14"))
	if err != nil {
		t.Fatalf("a three-night stay should be accepted: %v", err)
	}
	if len(nights) != 3 {
		t.Errorf("got %d nights, want 3", len(nights))
	}
}

// --- places -----------------------------------------------------------------

func TestValidatePlace(t *testing.T) {
	place, err := ValidatePlace(map[string]any{
		"name":                " Лесная долина ",
		"address":             "Габала",
		"hasFoodService":      true,
		"breakfastPriceMinor": 1500,
		"lunchPriceMinor":     2500,
		"dinnerPriceMinor":    3000,
	})
	if err != nil {
		t.Fatalf("ValidatePlace: %v", err)
	}
	if place.Name != "Лесная долина" {
		t.Errorf("name = %q, want trimmed", place.Name)
	}
	if !place.HasFoodService {
		t.Error("hasFoodService should be true")
	}
	if place.BreakfastPriceMinor != 1500 || place.LunchPriceMinor != 2500 || place.DinnerPriceMinor != 3000 {
		t.Errorf("meal prices = %d/%d/%d", place.BreakfastPriceMinor, place.LunchPriceMinor, place.DinnerPriceMinor)
	}
	// Default status is active, so a client that omits the field creates a usable place.
	if place.Status != "active" {
		t.Errorf("status = %q, want active", place.Status)
	}
}

// TestValidatePlaceZeroesMealPricesWithoutFoodService pins a rule that prevents a
// charge nobody can deliver: a place with no kitchen must not carry meal prices.
func TestValidatePlaceZeroesMealPricesWithoutFoodService(t *testing.T) {
	place, err := ValidatePlace(map[string]any{
		"name":                "Без кухни",
		"hasFoodService":      false,
		"breakfastPriceMinor": 1500,
		"lunchPriceMinor":     2500,
		"dinnerPriceMinor":    3000,
	})
	if err != nil {
		t.Fatalf("ValidatePlace: %v", err)
	}
	if place.BreakfastPriceMinor != 0 || place.LunchPriceMinor != 0 || place.DinnerPriceMinor != 0 {
		t.Errorf("meal prices must be zeroed without food service, got %d/%d/%d",
			place.BreakfastPriceMinor, place.LunchPriceMinor, place.DinnerPriceMinor)
	}
}

func TestValidatePlaceRequiresNameAndValidatesPrices(t *testing.T) {
	if _, err := ValidatePlace(map[string]any{}); fieldCode(t, err) != CodeRequired {
		t.Errorf("a missing name should be required, got %v", err)
	}
	// A negative meal price on a place WITH a kitchen must be rejected rather than
	// silently accepted as a credit.
	_, err := ValidatePlace(map[string]any{
		"name": "С кухней", "hasFoodService": true, "breakfastPriceMinor": -100,
	})
	if fieldCode(t, err) != CodeNotAnInteger {
		t.Errorf("a negative meal price should be rejected, got %v", err)
	}
}

func TestValidatePlaceAcceptsTruthyRepresentations(t *testing.T) {
	// JSON clients vary: a checkbox may send true, 1, or "1".
	for _, value := range []any{true, 1, "1", "true"} {
		place, err := ValidatePlace(map[string]any{"name": "X", "hasFoodService": value})
		if err != nil {
			t.Fatalf("ValidatePlace(hasFoodService=%v): %v", value, err)
		}
		if !place.HasFoodService {
			t.Errorf("hasFoodService=%v should be truthy", value)
		}
	}
	for _, value := range []any{false, 0, "0", nil, ""} {
		place, err := ValidatePlace(map[string]any{"name": "X", "hasFoodService": value})
		if err != nil {
			t.Fatalf("ValidatePlace(hasFoodService=%v): %v", value, err)
		}
		if place.HasFoodService {
			t.Errorf("hasFoodService=%v should be falsy", value)
		}
	}
}

// --- units ------------------------------------------------------------------

func TestValidateUnit(t *testing.T) {
	unit, err := ValidateUnit(map[string]any{
		"name":           "Коттедж «Сосны»",
		"kind":           "cottage",
		"capacity":       6,
		"basePriceMinor": 24000,
		"depositMinor":   30000,
	}, nil)
	if err != nil {
		t.Fatalf("ValidateUnit: %v", err)
	}
	if unit.Kind != "cottage" {
		t.Errorf("kind = %q, want cottage", unit.Kind)
	}
	// Defaults must match the desktop so a client that omits them stores the same row.
	if unit.Currency != "AZN" {
		t.Errorf("currency = %q, want AZN", unit.Currency)
	}
	if unit.CheckInTime != "15:00" || unit.CheckOutTime != "11:00" {
		t.Errorf("times = %q/%q, want 15:00/11:00", unit.CheckInTime, unit.CheckOutTime)
	}
	if unit.PlaceID != nil {
		t.Error("a standalone house should have no place")
	}
}

func TestValidateUnitRejectsMissingOrArchivedPlace(t *testing.T) {
	for name, lookup := range map[string]UnitLookup{
		"missing":  func(string) (bool, bool) { return false, false },
		"archived": func(string) (bool, bool) { return true, false },
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateUnit(map[string]any{
				"name": "X", "capacity": 2, "basePriceMinor": 0, "depositMinor": 0, "placeId": "p1",
			}, lookup)
			// The message is identical for both, so a caller cannot probe for the
			// existence of another tenant's place.
			if fieldCode(t, err) != CodeValidation {
				t.Errorf("expected a validation error, got %v", err)
			}
		})
	}
}

func TestValidateUnitNormalizesTime(t *testing.T) {
	unit, err := ValidateUnit(map[string]any{
		"name": "X", "capacity": 2, "basePriceMinor": 0, "depositMinor": 0,
		"checkInTime": "9:05", "checkOutTime": "11:00",
	}, nil)
	if err != nil {
		t.Fatalf("ValidateUnit: %v", err)
	}
	// Re-rendered with a leading zero so stored values compare consistently.
	if unit.CheckInTime != "09:05" {
		t.Errorf("checkInTime = %q, want 09:05", unit.CheckInTime)
	}

	for _, bad := range []string{"25:00", "12:60", "noon", "12", "12:5"} {
		if _, err := ValidateUnit(map[string]any{
			"name": "X", "capacity": 2, "basePriceMinor": 0, "depositMinor": 0, "checkInTime": bad,
		}, nil); err == nil {
			t.Errorf("checkInTime %q should be rejected", bad)
		}
	}
}

func TestValidateUnitUppercasesCurrencyAndBoundsIt(t *testing.T) {
	unit, err := ValidateUnit(map[string]any{
		"name": "X", "capacity": 2, "basePriceMinor": 0, "depositMinor": 0, "currency": "azn",
	}, nil)
	if err != nil {
		t.Fatalf("ValidateUnit: %v", err)
	}
	if unit.Currency != "AZN" {
		t.Errorf("currency = %q, want AZN", unit.Currency)
	}

	if _, err := ValidateUnit(map[string]any{
		"name": "X", "capacity": 2, "basePriceMinor": 0, "depositMinor": 0, "currency": "EURO",
	}, nil); fieldCode(t, err) != CodeTooLong {
		t.Errorf("a four-letter currency should be rejected, got %v", err)
	}
}

// --- reservations -----------------------------------------------------------

// reservationDeps builds validator dependencies for a unit, with a controllable policy.
func reservationDeps(t *testing.T, options ...func(*ReservationDeps)) ReservationDeps {
	t.Helper()
	placeID := "place-1"
	deps := ReservationDeps{
		Unit: func(unitID string) (*ValidatedUnit, bool) {
			if unitID != "unit-1" {
				return nil, false
			}
			return &ValidatedUnit{
				ID: "unit-1", PlaceID: &placeID, Capacity: 6,
				BasePriceMinor: 24000, Status: "active",
			}, true
		},
		PlaceHasFoodService: func(string) bool { return true },
		Policy:              DefaultPolicy,
		Today:               MustParseDate("2026-08-11"),
	}
	for _, option := range options {
		option(&deps)
	}
	return deps
}

// validReservationPayload is the baseline every reservation test mutates.
func validReservationPayload() map[string]any {
	return map[string]any{
		"unitId":        "unit-1",
		"guestName":     "Иван Петров",
		"guestPhone":    "+994 50 123 45 67",
		"checkInDate":   "2026-08-12",
		"checkOutDate":  "2026-08-15",
		"adults":        2,
		"children":      1,
		"depositMinor":  30000,
		"depositStatus": "due",
	}
}

func TestValidateReservationComputesTotals(t *testing.T) {
	result, err := ValidateReservation(validReservationPayload(), reservationDeps(t))
	if err != nil {
		t.Fatalf("ValidateReservation: %v", err)
	}

	// Three nights at the unit's base price. The server computes this; a client that
	// sent its own total would be ignored.
	if len(result.Nights) != 3 {
		t.Fatalf("got %d nights, want 3", len(result.Nights))
	}
	if result.AccommodationMinor != 3*24000 {
		t.Errorf("accommodation = %d, want %d", result.AccommodationMinor, 3*24000)
	}
	if result.NightlyRateMinor != 24000 {
		t.Errorf("nightly rate = %d, want 24000", result.NightlyRateMinor)
	}
	if result.TotalMinor != result.AccommodationMinor+result.ServicesMinor {
		t.Errorf("total = %d, want accommodation + services", result.TotalMinor)
	}
	if result.GuestPhone != "+994501234567" {
		t.Errorf("phone = %q, want normalized", result.GuestPhone)
	}
	// Default status is hold: a new booking that is not explicitly confirmed should
	// not occupy dates as confirmed.
	if result.Status != StatusHold {
		t.Errorf("status = %q, want hold", result.Status)
	}
}

func TestValidateReservationRejectsCapacityOverflow(t *testing.T) {
	payload := validReservationPayload()
	payload["adults"] = 5
	payload["children"] = 2

	_, err := ValidateReservation(payload, reservationDeps(t))
	if fieldCode(t, err) != CodeCapacityExceeded {
		t.Errorf("expected a capacity error, got %v", err)
	}
	// Exactly at capacity is fine.
	payload["adults"] = 4
	payload["children"] = 2
	if _, err := ValidateReservation(payload, reservationDeps(t)); err != nil {
		t.Errorf("exactly at capacity should be accepted: %v", err)
	}
}

func TestValidateReservationEnforcesTheBookingPolicy(t *testing.T) {
	// Check-in beyond the 21-day window from the injected "today".
	payload := validReservationPayload()
	payload["checkInDate"] = "2026-09-15"
	payload["checkOutDate"] = "2026-09-17"

	_, err := ValidateReservation(payload, reservationDeps(t))
	if fieldCode(t, err) != CodeCheckInTooFar {
		t.Errorf("expected a booking-window violation, got %v", err)
	}

	// A past check-in.
	payload["checkInDate"] = "2026-08-01"
	payload["checkOutDate"] = "2026-08-03"
	if _, err := ValidateReservation(payload, reservationDeps(t)); fieldCode(t, err) != CodeCheckInPast {
		t.Errorf("expected a past check-in violation, got %v", err)
	}
}

func TestValidateReservationMealRules(t *testing.T) {
	t.Run("meals inside the stay are totalled", func(t *testing.T) {
		payload := validReservationPayload()
		payload["mealItems"] = []any{
			map[string]any{"date": "2026-08-12", "type": "breakfast", "amountMinor": 1500},
			map[string]any{"date": "2026-08-13", "type": "dinner", "amountMinor": 3000},
		}
		result, err := ValidateReservation(payload, reservationDeps(t))
		if err != nil {
			t.Fatalf("ValidateReservation: %v", err)
		}
		if result.ServicesMinor != 4500 {
			t.Errorf("services = %d, want 4500", result.ServicesMinor)
		}
		if result.TotalMinor != result.AccommodationMinor+4500 {
			t.Errorf("total = %d, want accommodation + 4500", result.TotalMinor)
		}
	})

	t.Run("zero-amount entries are ignored, not rejected", func(t *testing.T) {
		// The desktop sends a row per meal per night, including declined ones.
		payload := validReservationPayload()
		payload["mealItems"] = []any{
			map[string]any{"date": "2026-08-12", "type": "breakfast", "amountMinor": 0},
			map[string]any{"date": "2026-08-12", "type": "lunch", "amountMinor": 0},
			map[string]any{"date": "2026-08-13", "type": "dinner", "amountMinor": 2000},
		}
		result, err := ValidateReservation(payload, reservationDeps(t))
		if err != nil {
			t.Fatalf("zero-amount meals must not fail the booking: %v", err)
		}
		if result.ServicesMinor != 2000 {
			t.Errorf("services = %d, want 2000", result.ServicesMinor)
		}
	})

	t.Run("a meal outside the stay is rejected", func(t *testing.T) {
		payload := validReservationPayload()
		// The check-out day is not occupied, so a meal there is not deliverable.
		payload["mealItems"] = []any{
			map[string]any{"date": "2026-08-15", "type": "breakfast", "amountMinor": 1500},
		}
		if _, err := ValidateReservation(payload, reservationDeps(t)); fieldCode(t, err) != CodeMealOutsideStay {
			t.Errorf("expected a meal-outside-stay error, got %v", err)
		}
	})

	t.Run("a duplicate meal is rejected", func(t *testing.T) {
		payload := validReservationPayload()
		payload["mealItems"] = []any{
			map[string]any{"date": "2026-08-12", "type": "breakfast", "amountMinor": 1500},
			map[string]any{"date": "2026-08-12", "type": "breakfast", "amountMinor": 1500},
		}
		if _, err := ValidateReservation(payload, reservationDeps(t)); fieldCode(t, err) != CodeMealDuplicate {
			t.Errorf("expected a duplicate-meal error, got %v", err)
		}
	})

	t.Run("an unknown meal type is rejected", func(t *testing.T) {
		payload := validReservationPayload()
		payload["mealItems"] = []any{
			map[string]any{"date": "2026-08-12", "type": "brunch", "amountMinor": 1500},
		}
		if _, err := ValidateReservation(payload, reservationDeps(t)); fieldCode(t, err) != CodeMealUnknownType {
			t.Errorf("expected an unknown-meal-type error, got %v", err)
		}
	})

	t.Run("meals require a kitchen", func(t *testing.T) {
		payload := validReservationPayload()
		payload["mealItems"] = []any{
			map[string]any{"date": "2026-08-12", "type": "breakfast", "amountMinor": 1500},
		}
		deps := reservationDeps(t, func(d *ReservationDeps) {
			d.PlaceHasFoodService = func(string) bool { return false }
		})
		if _, err := ValidateReservation(payload, deps); fieldCode(t, err) != CodeFoodServiceOff {
			t.Errorf("expected a food-service error, got %v", err)
		}
	})
}

func TestValidateReservationMoneyRules(t *testing.T) {
	t.Run("prepaid may not exceed the total", func(t *testing.T) {
		payload := validReservationPayload()
		// Three nights at 24000 is 72000; ask for more.
		payload["prepaidMinor"] = 100000
		if _, err := ValidateReservation(payload, reservationDeps(t)); fieldCode(t, err) != CodePrepaidTooLarge {
			t.Errorf("expected a prepaid error, got %v", err)
		}
	})

	t.Run("prepaid equal to the total is allowed", func(t *testing.T) {
		payload := validReservationPayload()
		payload["prepaidMinor"] = 72000
		if _, err := ValidateReservation(payload, reservationDeps(t)); err != nil {
			t.Errorf("full prepayment should be accepted: %v", err)
		}
	})

	t.Run("a deposit status without an amount is rejected", func(t *testing.T) {
		payload := validReservationPayload()
		payload["depositMinor"] = 0
		payload["depositStatus"] = "received"
		if _, err := ValidateReservation(payload, reservationDeps(t)); fieldCode(t, err) != CodeDepositMissing {
			t.Errorf("expected a deposit error, got %v", err)
		}
	})

	t.Run("no deposit with status none is allowed", func(t *testing.T) {
		payload := validReservationPayload()
		payload["depositMinor"] = 0
		payload["depositStatus"] = "none"
		if _, err := ValidateReservation(payload, reservationDeps(t)); err != nil {
			t.Errorf("no deposit should be accepted: %v", err)
		}
	})
}

func TestValidateReservationRejectsInactiveUnit(t *testing.T) {
	deps := reservationDeps(t, func(d *ReservationDeps) {
		d.Unit = func(string) (*ValidatedUnit, bool) {
			return &ValidatedUnit{ID: "unit-1", Capacity: 6, Status: "archived"}, true
		}
	})
	if _, err := ValidateReservation(validReservationPayload(), deps); fieldCode(t, err) != CodeValidation {
		t.Errorf("an archived unit should be refused, got %v", err)
	}

	// A unit belonging to another tenant is indistinguishable from a missing one.
	deps = reservationDeps(t, func(d *ReservationDeps) {
		d.Unit = func(string) (*ValidatedUnit, bool) { return nil, false }
	})
	if _, err := ValidateReservation(validReservationPayload(), deps); fieldCode(t, err) != CodeValidation {
		t.Errorf("an unknown unit should be refused, got %v", err)
	}
}

// TestValidateReservationSkipsUnchangedDates is the edit path: a booking made long ago
// must remain editable, even though its dates are now in the past. Re-validating them
// against today's window would make every old booking permanently unmodifiable.
func TestValidateReservationSkipsUnchangedDates(t *testing.T) {
	oldCheckIn := MustParseDate("2020-01-01")
	oldCheckOut := MustParseDate("2020-01-04")

	payload := validReservationPayload()
	payload["checkInDate"] = "2020-01-01"
	payload["checkOutDate"] = "2020-01-04"

	deps := reservationDeps(t, func(d *ReservationDeps) {
		d.Existing = &ExistingReservation{
			ID: "res-1", UnitID: "unit-1", CheckIn: oldCheckIn, CheckOut: oldCheckOut,
			NightlyRateMinor: 24000, AccommodationMinor: 72000,
		}
	})

	// An edit that only touches the guest name must succeed.
	payload["guestName"] = "Исправленное имя"
	result, err := ValidateReservation(payload, deps)
	if err != nil {
		t.Fatalf("editing an old booking must succeed: %v", err)
	}
	if result.GuestName != "Исправленное имя" {
		t.Errorf("guest name = %q", result.GuestName)
	}
	// The stored rate is preserved even if the unit's price has since changed.
	if result.NightlyRateMinor != 24000 {
		t.Errorf("nightly rate = %d, want the stored 24000", result.NightlyRateMinor)
	}
}

// TestValidateReservationFreezesTheTotalAfterEarlyCheckOut covers the case the desktop
// treats specially: once a guest leaves early, the charged accommodation total is final
// and meals stop at the departure date, while the dates themselves may not move past it.
func TestValidateReservationFreezesTheTotalAfterEarlyCheckOut(t *testing.T) {
	early := MustParseDate("2026-08-13")

	deps := reservationDeps(t, func(d *ReservationDeps) {
		// "Today" is the check-in date, so the unchanged check-in passes the booking
		// window and the early-departure rule is what decides the outcome. With a
		// later today the past-check-in check would fire first and the test would be
		// measuring the wrong rule.
		d.Today = MustParseDate("2026-08-12")
		d.Existing = &ExistingReservation{
			ID: "res-1", UnitID: "unit-1",
			CheckIn:  MustParseDate("2026-08-12"),
			CheckOut: MustParseDate("2026-08-15"),
			// The guest was billed for all three nights.
			NightlyRateMinor: 24000, AccommodationMinor: 72000,
			ActualCheckOut: &early,
		}
	})

	payload := validReservationPayload()
	payload["checkInDate"] = "2026-08-12"
	payload["checkOutDate"] = "2026-08-15"
	// Breakfast on the morning of the early departure is billable: the guest is still
	// there to eat it. Excluding the departure date would silently drop this charge.
	payload["mealItems"] = []any{
		map[string]any{"date": "2026-08-13", "type": "breakfast", "amountMinor": 1500},
	}

	result, err := ValidateReservation(payload, deps)
	if err != nil {
		t.Fatalf("ValidateReservation: %v", err)
	}
	if result.AccommodationMinor != 72000 {
		t.Errorf("accommodation = %d, want the frozen 72000", result.AccommodationMinor)
	}
	if result.ServicesMinor != 1500 {
		t.Errorf("services = %d, want 1500", result.ServicesMinor)
	}

	// Extending the stay past what was originally booked is refused: the stay was
	// settled when the guest left, so the booked range must not grow.
	//
	// Only check-out changes here, so the booking window is skipped and the
	// early-departure rule is the one under test.
	payload["checkOutDate"] = "2026-08-16"
	if _, err := ValidateReservation(payload, deps); fieldCode(t, err) != CodeValidation {
		t.Errorf("extending a settled stay should be refused, got %v", err)
	}

	// The original booked dates remain editable, so the stay can still be corrected
	// without being frozen out of the API entirely.
	payload["checkOutDate"] = "2026-08-15"
	if _, err := ValidateReservation(payload, deps); err != nil {
		t.Errorf("the unchanged booked range must remain editable: %v", err)
	}
}

// TestStatusHelpersMatchTheDatabaseConstraint keeps Occupies() honest against the
// exclusion constraint: if they disagree, a status that occupies dates in Go but not in
// the constraint could be double-booked.
func TestStatusHelpersMatchTheDatabaseConstraint(t *testing.T) {
	// These three are exactly the statuses in the constraint's WHERE clause.
	for _, status := range []ReservationStatus{StatusHold, StatusConfirmed, StatusCheckedIn} {
		if !status.Occupies() {
			t.Errorf("%q should occupy its dates", status)
		}
	}
	for _, status := range []ReservationStatus{
		StatusCheckedOut, StatusCancelled, StatusNoShow, StatusConflict,
	} {
		if status.Occupies() {
			t.Errorf("%q must not occupy its dates", status)
		}
	}
}

// TestConflictStatusIsNotClientSettable matters for the admin queue: if a client could
// set `conflict`, it could hide a genuine double-booking from the people who resolve it.
func TestConflictStatusIsNotClientSettable(t *testing.T) {
	for _, allowed := range ValidStatuses {
		if allowed == StatusConflict {
			t.Fatal("conflict must not be a client-settable status")
		}
	}
	if got := ParseReservationStatus("conflict"); got == StatusConflict {
		t.Error("a client-supplied conflict status must not be honored")
	}
	// An unrecognized status falls back to hold, the least committing state.
	if got := ParseReservationStatus("nonsense"); got != StatusHold {
		t.Errorf("unknown status = %q, want hold", got)
	}
}

func TestAsFieldErrorUnwraps(t *testing.T) {
	_, err := ValidatePlace(map[string]any{})
	if err == nil {
		t.Fatal("expected an error")
	}
	wrapped := errors.Join(errors.New("context"), err)
	fieldErr, ok := AsFieldError(wrapped)
	if !ok {
		t.Fatal("AsFieldError should find a wrapped FieldError")
	}
	if fieldErr.Field != "name" {
		t.Errorf("field = %q, want name", fieldErr.Field)
	}
}

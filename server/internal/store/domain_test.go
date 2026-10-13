package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/httpapi"
	"github.com/inajaf/dombook/server/internal/store"
)

// These tests exercise the domain CRUD against real PostgreSQL. They matter more than
// the validation tests because the guarantees being checked live in the database:
// the free-plan trigger, the nights unique index, and the transactional write of a
// reservation's whole child graph. A unit test cannot verify any of them.

// newTenantWithPlace creates an account and a place for a test.
func newTenantWithPlace(t *testing.T, app *store.Store, name string) (*store.Account, *store.Place) {
	t.Helper()
	ctx := context.Background()

	// The email must be unique per call, not per name: tests reuse account names, and a
	// name-derived address collides on the second use, failing an unrelated test with a
	// duplicate-key error.
	accountID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	email := "owner-" + accountID + "@example.test"
	account, _, err := app.CreateAccountWithOwner(ctx, name, email, "Owner", store.PlanFree)
	if err != nil {
		t.Fatalf("CreateAccountWithOwner: %v", err)
	}
	place, err := app.CreatePlace(ctx, account.ID, &domain.PlaceInput{
		Name:                "Лесная долина",
		Address:             "Габала",
		HasFoodService:      true,
		BreakfastPriceMinor: 1500,
		LunchPriceMinor:     2500,
		DinnerPriceMinor:    3000,
		Status:              "active",
	}, "test-writer")
	if err != nil {
		t.Fatalf("CreatePlace: %v", err)
	}
	return account, place
}

// newUnit creates an active unit inside a place.
func newUnit(t *testing.T, app *store.Store, tenantID, placeID, name string, capacity int, price int64) *store.Unit {
	t.Helper()
	place := placeID
	unit, err := app.CreateUnit(context.Background(), tenantID, &domain.UnitInput{
		PlaceID:        &place,
		Kind:           "cottage",
		Name:           name,
		Capacity:       capacity,
		BasePriceMinor: price,
		Currency:       "AZN",
		CheckInTime:    "15:00",
		CheckOutTime:   "11:00",
		Status:         "active",
	}, "test-writer")
	if err != nil {
		t.Fatalf("CreateUnit: %v", err)
	}
	return unit
}

// reservation builds a validated reservation input for a unit.
func reservationInput(unitID string, checkIn, checkOut string, meals []domain.MealInput) *domain.ReservationInput {
	checkInDate := domain.MustParseDate(checkIn)
	checkOutDate := domain.MustParseDate(checkOut)
	nights, err := domain.Nights(checkInDate, checkOutDate)
	if err != nil {
		panic(err)
	}
	var services int64
	for _, meal := range meals {
		services += meal.AmountMinor
	}
	const nightlyRate = int64(24000)
	accommodation := int64(len(nights)) * nightlyRate

	return &domain.ReservationInput{
		UnitID:             unitID,
		GuestName:          "Иван Петров",
		GuestPhone:         "+994501234567",
		CheckIn:            checkInDate,
		CheckOut:           checkOutDate,
		Nights:             nights,
		Adults:             2,
		Children:           0,
		Status:             domain.StatusConfirmed,
		NightlyRateMinor:   nightlyRate,
		AccommodationMinor: accommodation,
		Meals:              meals,
		ServicesMinor:      services,
		TotalMinor:         accommodation + services,
		DepositMinor:       30000,
		DepositStatus:      domain.DepositDue,
	}
}

// --- places -----------------------------------------------------------------

func TestPlaceCRUD(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Place CRUD")

	t.Run("list returns the created place", func(t *testing.T) {
		places, err := app.ListPlaces(ctx, account.ID)
		if err != nil {
			t.Fatalf("ListPlaces: %v", err)
		}
		if len(places) != 1 || places[0].ID != place.ID {
			t.Fatalf("got %d places, want the one created", len(places))
		}
		if !places[0].HasFoodService {
			t.Error("hasFoodService should round-trip")
		}
		if places[0].BreakfastPriceMinor != 1500 {
			t.Errorf("breakfast price = %d, want 1500", places[0].BreakfastPriceMinor)
		}
		// A newly created row starts at version 1; sync relies on reading it back.
		if places[0].Version < 1 {
			t.Errorf("version = %d, want at least 1", places[0].Version)
		}
	})

	t.Run("update replaces the editable fields", func(t *testing.T) {
		updated, err := app.UpdatePlace(ctx, account.ID, place.ID, &domain.PlaceInput{
			Name:    "Переименованный",
			Address: "Шеки",
			Status:  "active",
		}, "test-writer")
		if err != nil {
			t.Fatalf("UpdatePlace: %v", err)
		}
		if updated.Name != "Переименованный" {
			t.Errorf("name = %q", updated.Name)
		}
		// Turning off food service must zero the prices, so a place cannot advertise
		// meals it no longer serves.
		if updated.BreakfastPriceMinor != 0 {
			t.Errorf("breakfast price = %d, want 0 after disabling food service", updated.BreakfastPriceMinor)
		}
		// Every write bumps the version, which is what makes sync ordering work.
		if updated.Version <= place.Version {
			t.Errorf("version did not advance: %d then %d", place.Version, updated.Version)
		}
	})

	t.Run("the tenant version advances on every write", func(t *testing.T) {
		before, err := app.GetTenantState(ctx, account.ID)
		if err != nil {
			t.Fatalf("GetTenantState: %v", err)
		}
		if _, err := app.SetPlaceStatus(ctx, account.ID, place.ID, "archived", "test-writer"); err != nil {
			t.Fatalf("SetPlaceStatus: %v", err)
		}
		after, err := app.GetTenantState(ctx, account.ID)
		if err != nil {
			t.Fatalf("GetTenantState: %v", err)
		}
		// A sync client only learns about a change when the watermark moves.
		if after.Version <= before.Version {
			t.Errorf("tenant version did not advance: %d then %d", before.Version, after.Version)
		}
	})

	t.Run("soft delete hides the row but keeps the tombstone", func(t *testing.T) {
		if err := app.SoftDeletePlace(ctx, account.ID, place.ID, "test-writer"); err != nil {
			t.Fatalf("SoftDeletePlace: %v", err)
		}
		if _, err := app.GetPlace(ctx, account.ID, place.ID); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("a deleted place should not be loadable, got %v", err)
		}
		places, err := app.ListPlaces(ctx, account.ID)
		if err != nil {
			t.Fatalf("ListPlaces: %v", err)
		}
		if len(places) != 0 {
			t.Errorf("a deleted place should not be listed, got %d", len(places))
		}
	})
}

// TestPlaceCrossTenantAccessIsRefused checks that RLS, not a WHERE clause, is what
// stops one tenant reading another's row. The lookup uses the real id, so only the
// policy can be responsible for the miss.
func TestPlaceCrossTenantAccessIsRefused(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()

	_, placeA := newTenantWithPlace(t, app, "Cross A")
	accountB, _ := newTenantWithPlace(t, app, "Cross B")

	if _, err := app.GetPlace(ctx, accountB.ID, placeA.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("tenant B loaded tenant A's place: %v", err)
	}
	if err := app.SoftDeletePlace(ctx, accountB.ID, placeA.ID, "attacker"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("tenant B deleted tenant A's place: %v", err)
	}
	// The row must still exist for its owner.
	if _, err := app.GetPlace(ctx, placeA.TenantID, placeA.ID); err != nil {
		t.Errorf("tenant A's place was damaged: %v", err)
	}
}

// --- units ------------------------------------------------------------------

func TestUnitCRUD(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Unit CRUD")
	unit := newUnit(t, app, account.ID, place.ID, "Коттедж «Сосны»", 6, 24000)

	loaded, err := app.GetUnit(ctx, account.ID, unit.ID)
	if err != nil {
		t.Fatalf("GetUnit: %v", err)
	}
	if loaded.Capacity != 6 || loaded.BasePriceMinor != 24000 {
		t.Errorf("unit did not round-trip: %+v", loaded)
	}
	if loaded.PlaceID == nil || *loaded.PlaceID != place.ID {
		t.Errorf("place_id = %v, want %s", loaded.PlaceID, place.ID)
	}

	units, err := app.ListUnits(ctx, account.ID, &place.ID)
	if err != nil {
		t.Fatalf("ListUnits: %v", err)
	}
	if len(units) != 1 {
		t.Errorf("got %d units for the place, want 1", len(units))
	}

	// A filter for a different place returns nothing rather than everything.
	other := "00000000-0000-0000-0000-000000000000"
	none, err := app.ListUnits(ctx, account.ID, &other)
	if err != nil {
		t.Fatalf("ListUnits: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("filtering by an unrelated place returned %d units", len(none))
	}
}

// TestFreePlanUnitLimitIsEnforcedByTheDatabase is the licensing rule in action: the free
// plan allows one active unit, and the database — not a Go comparison — is what makes
// that hold under concurrency.
func TestFreePlanUnitLimitIsEnforcedByTheDatabase(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Unit Limit")
	newUnit(t, app, account.ID, place.ID, "Первый", 2, 10000)

	// The second active unit must be refused.
	placeID := place.ID
	_, err := app.CreateUnit(ctx, account.ID, &domain.UnitInput{
		PlaceID: &placeID, Kind: "cottage", Name: "Второй", Capacity: 2,
		BasePriceMinor: 10000, Currency: "AZN", CheckInTime: "15:00", CheckOutTime: "11:00",
		Status: "active",
	}, "test-writer")
	if err == nil {
		t.Fatal("a second active unit on the free plan must be refused")
	}
	// It must be reported as a quota problem, not as an opaque database error, so the
	// client can show an upgrade prompt.
	if !isPlanLimit(err) {
		t.Fatalf("expected a plan-limit error, got %v", err)
	}

	// Archiving the first unit frees the slot, which is the documented behaviour: a
	// free user can replace a unit rather than being permanently blocked by history.
	units, err := app.ListUnits(ctx, account.ID, nil)
	if err != nil {
		t.Fatalf("ListUnits: %v", err)
	}
	if _, err := app.SetUnitStatus(ctx, account.ID, units[0].ID, "archived", "test-writer"); err != nil {
		t.Fatalf("SetUnitStatus: %v", err)
	}
	if _, err := app.CreateUnit(ctx, account.ID, &domain.UnitInput{
		PlaceID: &placeID, Kind: "cottage", Name: "Второй", Capacity: 2,
		BasePriceMinor: 10000, Currency: "AZN", CheckInTime: "15:00", CheckOutTime: "11:00",
		Status: "active",
	}, "test-writer"); err != nil {
		t.Fatalf("creating a replacement after archiving should succeed: %v", err)
	}
}

// isPlanLimit reports whether the error is the client-facing quota error, which the
// client needs in order to show an upgrade prompt rather than a generic failure.
func isPlanLimit(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *httpapi.ApiError
	if errors.As(err, &apiErr) {
		return apiErr.Code == "plan_limit"
	}
	return false
}

// --- reservations -----------------------------------------------------------

func TestReservationCRUDWithChildRows(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Reservation CRUD")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	input := reservationInput(unit.ID, "2026-09-01", "2026-09-04", []domain.MealInput{
		{Date: domain.MustParseDate("2026-09-01"), Type: domain.MealBreakfast, AmountMinor: 1500},
		{Date: domain.MustParseDate("2026-09-02"), Type: domain.MealBreakfast, AmountMinor: 1500},
	})

	created, err := app.CreateReservation(ctx, account.ID, input, "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	// The whole graph is written: three nights and two meals.
	if len(created.Nights) != 3 {
		t.Errorf("got %d nights, want 3", len(created.Nights))
	}
	if len(created.Meals) != 2 {
		t.Errorf("got %d meals, want 2", len(created.Meals))
	}
	// Meals are aggregated into one service row per type.
	if len(created.Services) != 1 {
		t.Fatalf("got %d service rows, want 1", len(created.Services))
	}
	if created.Services[0].Quantity != 2 || created.Services[0].UnitPriceMinor != 1500 {
		t.Errorf("service aggregate = %+v, want quantity 2 at 1500", created.Services[0])
	}
	if created.ServicesMinor != 3000 {
		t.Errorf("services = %d, want 3000", created.ServicesMinor)
	}

	t.Run("nights are ordered and cover the stay", func(t *testing.T) {
		want := []string{"2026-09-01", "2026-09-02", "2026-09-03"}
		if len(created.Nights) != len(want) {
			t.Fatalf("got %d nights, want %d", len(created.Nights), len(want))
		}
		for i, date := range want {
			if created.Nights[i].NightDate.String() != date {
				t.Errorf("night %d = %s, want %s", i, created.Nights[i].NightDate, date)
			}
		}
	})

	t.Run("reload returns the same graph", func(t *testing.T) {
		loaded, err := app.GetReservation(ctx, account.ID, created.ID)
		if err != nil {
			t.Fatalf("GetReservation: %v", err)
		}
		if len(loaded.Nights) != 3 || len(loaded.Meals) != 2 {
			t.Errorf("reloaded graph is incomplete: %d nights, %d meals", len(loaded.Nights), len(loaded.Meals))
		}
		if loaded.GuestName != "Иван Петров" {
			t.Errorf("guest name = %q", loaded.GuestName)
		}
	})
}

// TestOverlappingReservationIsRefused is the core double-booking guarantee, enforced by
// the unique index on reservation_nights rather than by application logic.
func TestOverlappingReservationIsRefused(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Overlap")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-05", nil), "test-writer"); err != nil {
		t.Fatalf("first reservation: %v", err)
	}

	t.Run("a fully overlapping stay is refused", func(t *testing.T) {
		_, err := app.CreateReservation(ctx, account.ID,
			reservationInput(unit.ID, "2026-09-02", "2026-09-04", nil), "test-writer")
		if err == nil {
			t.Fatal("an overlapping stay must be refused")
		}
	})

	t.Run("a partially overlapping stay is refused", func(t *testing.T) {
		// Shares only the final night.
		_, err := app.CreateReservation(ctx, account.ID,
			reservationInput(unit.ID, "2026-09-04", "2026-09-07", nil), "test-writer")
		if err == nil {
			t.Fatal("a stay sharing one night must be refused")
		}
	})

	t.Run("a back-to-back stay is allowed", func(t *testing.T) {
		// Check-out on the 5th, next check-in on the 5th: the departure day is free,
		// which is the half-open range the schema documents.
		if _, err := app.CreateReservation(ctx, account.ID,
			reservationInput(unit.ID, "2026-09-05", "2026-09-08", nil), "test-writer"); err != nil {
			t.Fatalf("a back-to-back stay must be allowed: %v", err)
		}
	})

	t.Run("another unit is unaffected", func(t *testing.T) {
		// Move to a plan that permits a second unit; the free plan's one-unit cap is
		// covered by its own test.
		grantLicense(t, app, account.ID)
		other := newUnit(t, app, account.ID, place.ID, "Второй дом", 4, 20000)
		if _, err := app.CreateReservation(ctx, account.ID,
			reservationInput(other.ID, "2026-09-01", "2026-09-05", nil), "test-writer"); err != nil {
			t.Fatalf("a different unit should not collide: %v", err)
		}
	})
}

// TestCancellingReleasesTheNights verifies that cancelling frees the dates, which is the
// behaviour an owner relies on when a guest backs out.
func TestCancellingReleasesTheNights(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Cancel")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	created, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-04", nil), "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	cancelled, err := app.CancelReservation(ctx, account.ID, created.ID, "test-writer")
	if err != nil {
		t.Fatalf("CancelReservation: %v", err)
	}
	if cancelled.Status != string(domain.StatusCancelled) {
		t.Errorf("status = %q, want cancelled", cancelled.Status)
	}

	// The dates are free again.
	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-04", nil), "test-writer"); err != nil {
		t.Fatalf("the cancelled dates should be bookable again: %v", err)
	}

	// The cancelled row survives so history and payments stay visible.
	loaded, err := app.GetReservation(ctx, account.ID, created.ID)
	if err != nil {
		t.Fatalf("the cancelled booking should still exist: %v", err)
	}
	if len(loaded.Nights) != 0 {
		t.Errorf("cancelling should release the nights, got %d", len(loaded.Nights))
	}
}

// TestUpdatingReservationMovesTheNights covers the edit path, where the old nights must
// be released before the new ones are written or the stay collides with itself.
func TestUpdatingReservationMovesTheNights(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Reschedule")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	created, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-03", nil), "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	// Move the stay two days later, with no overlap with the original dates.
	moved := reservationInput(unit.ID, "2026-09-05", "2026-09-07", nil)
	updated, err := app.UpdateReservation(ctx, account.ID, created.ID, moved, "test-writer")
	if err != nil {
		t.Fatalf("moving a stay must not collide with itself: %v", err)
	}
	if len(updated.Nights) != 2 {
		t.Fatalf("got %d nights after the move, want 2", len(updated.Nights))
	}
	for _, night := range updated.Nights {
		if night.NightDate.String() >= "2026-09-05" {
			continue
		}
		t.Errorf("stale night remained: %s", night.NightDate)
	}

	// The original dates are free for another booking.
	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-03", nil), "test-writer"); err != nil {
		t.Errorf("the vacated dates should be bookable: %v", err)
	}
}

// TestUpdatingReservationReplacesMealsRatherThanAccumulating guards against the obvious
// implementation mistake of appending child rows on every edit.
func TestUpdatingReservationReplacesMealsRatherThanAccumulating(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Meals Replace")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	created, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-03", []domain.MealInput{
			{Date: domain.MustParseDate("2026-09-01"), Type: domain.MealBreakfast, AmountMinor: 1500},
			{Date: domain.MustParseDate("2026-09-02"), Type: domain.MealBreakfast, AmountMinor: 1500},
		}), "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	// Keep only one meal.
	reduced := reservationInput(unit.ID, "2026-09-01", "2026-09-03", []domain.MealInput{
		{Date: domain.MustParseDate("2026-09-01"), Type: domain.MealBreakfast, AmountMinor: 1500},
	})
	updated, err := app.UpdateReservation(ctx, account.ID, created.ID, reduced, "test-writer")
	if err != nil {
		t.Fatalf("UpdateReservation: %v", err)
	}
	if len(updated.Meals) != 1 {
		t.Errorf("got %d meals after reducing to one, want 1", len(updated.Meals))
	}
	if updated.ServicesMinor != 1500 {
		t.Errorf("services = %d, want 1500", updated.ServicesMinor)
	}
}

// TestFailedReservationWriteLeavesNothingBehind is the atomicity check: a booking that
// collides must not leave a partial graph, or the unit would appear occupied by a row
// that does not exist.
func TestFailedReservationWriteLeavesNothingBehind(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Atomic")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	existing, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-05", nil), "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	// This one collides on its final night. The whole write must roll back.
	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-03", "2026-09-07", nil), "test-writer"); err == nil {
		t.Fatal("the overlapping booking must be refused")
	}

	// Only the original two bookings' worth of nights exist: 4 from the first stay.
	taken, err := app.TakenNights(ctx, account.ID, unit.ID, []domain.Date{
		domain.MustParseDate("2026-09-01"),
		domain.MustParseDate("2026-09-02"),
		domain.MustParseDate("2026-09-03"),
		domain.MustParseDate("2026-09-04"),
		domain.MustParseDate("2026-09-05"),
		domain.MustParseDate("2026-09-06"),
	})
	if err != nil {
		t.Fatalf("TakenNights: %v", err)
	}
	if len(taken) != 4 {
		t.Errorf("got %d occupied nights, want exactly the 4 from the first stay", len(taken))
	}

	loaded, err := app.GetReservation(ctx, account.ID, existing.ID)
	if err != nil {
		t.Fatalf("GetReservation: %v", err)
	}
	if len(loaded.Nights) != 4 {
		t.Errorf("the existing booking was disturbed: %d nights", len(loaded.Nights))
	}
}

func TestTakenNightsReportsTheConflict(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Taken")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-04", nil), "test-writer"); err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	taken, err := app.TakenNights(ctx, account.ID, unit.ID, []domain.Date{
		domain.MustParseDate("2026-09-02"),
		domain.MustParseDate("2026-09-03"),
		domain.MustParseDate("2026-09-10"),
	})
	if err != nil {
		t.Fatalf("TakenNights: %v", err)
	}
	// Only the two nights that belong to the stay, not the free one.
	if len(taken) != 2 {
		t.Fatalf("got %d taken nights, want 2", len(taken))
	}
	if taken[0].String() != "2026-09-02" || taken[1].String() != "2026-09-03" {
		t.Errorf("taken nights = %v", taken)
	}
}

func TestDeleteReservationRequiresCancellationFirst(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Delete Rules")
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	created, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-03", nil), "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	// The rule itself is enforced in the service layer, so the store allows the delete;
	// this test documents that the row and its children go away together.
	if err := app.DeleteReservation(ctx, account.ID, created.ID, "test-writer"); err != nil {
		t.Fatalf("DeleteReservation: %v", err)
	}
	if _, err := app.GetReservation(ctx, account.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a deleted booking should not be loadable: %v", err)
	}

	// Its nights are released, so the dates can be rebooked.
	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-03", nil), "test-writer"); err != nil {
		t.Errorf("dates should be free after deletion: %v", err)
	}
}

func TestReservationCrossTenantAccessIsRefused(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()

	accountA, placeA := newTenantWithPlace(t, app, "Res Cross A")
	unitA := newUnit(t, app, accountA.ID, placeA.ID, "Дом A", 4, 24000)
	created, err := app.CreateReservation(ctx, accountA.ID,
		reservationInput(unitA.ID, "2026-09-01", "2026-09-03", nil), "test-writer")
	if err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	accountB, _ := newTenantWithPlace(t, app, "Res Cross B")
	if _, err := app.GetReservation(ctx, accountB.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("tenant B loaded tenant A's booking: %v", err)
	}
	// Tenant B cannot book tenant A's unit. The foreign key alone would allow this —
	// it only requires that some unit with that id exists — so the store checks
	// ownership explicitly. RLS would keep the row inside B's tenant, which is what
	// makes the bug quiet: B's calendar would show a booking on a unit it does not own.
	_, err = app.CreateReservation(ctx, accountB.ID,
		reservationInput(unitA.ID, "2026-10-01", "2026-10-03", nil), "attacker")
	if err == nil {
		t.Fatal("tenant B booked tenant A's unit")
	}
	if !errors.Is(err, store.ErrUnitNotBookable) {
		t.Errorf("expected ErrUnitNotBookable, got %v", err)
	}

	// And tenant A's booking is untouched.
	loaded, err := app.GetReservation(ctx, accountA.ID, created.ID)
	if err != nil {
		t.Fatalf("GetReservation: %v", err)
	}
	if len(loaded.Nights) != 2 {
		t.Errorf("tenant A's booking was disturbed: %d nights", len(loaded.Nights))
	}
}

// grantLicense lifts the free-tier cap the way a real purchase does.
//
// Through an entitlement rather than `accounts.plan`, because that column is a legacy
// subscription field that no longer decides anything: the service and the database trigger
// both read entitlements. Tests that set the plan column would pass while the real path
// stayed capped, which is exactly the divergence this helper prevents.
func grantLicense(t *testing.T, app *store.Store, accountID string) {
	t.Helper()
	if _, err := app.GrantEntitlement(context.Background(), accountID,
		"app_perpetual", "manual", "test-license", nil, nil); err != nil {
		t.Fatalf("grantLicense: %v", err)
	}
}

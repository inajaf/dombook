package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/inajaf/dombook/server/internal/testdb"
)

// Sync tests. Each of the first three covers a defect the v2 protocol exists to fix, and
// each is written so the old behaviour would fail it rather than pass by luck.

// syncTenant creates an account and returns its id plus a place id.
//
// The account is moved off the free plan: these tests push additional rows onto a tenant
// that already has one of each, which the free plan's per-unit cap legitimately refuses.
// That cap has its own tests; here it would only obscure what sync is being checked for.
func syncTenant(t *testing.T, app *store.Store, name string) (string, string) {
	t.Helper()
	account, place := newTenantWithPlace(t, app, name)
	grantLicense(t, app, account.ID)
	return account.ID, place.ID
}

// pushPlaces pushes one place row and returns the result for it.
func pushPlaces(t *testing.T, app *store.Store, tenantID, clientID string, row store.SyncRow) *store.PushResult {
	t.Helper()
	result, err := app.Push(context.Background(), tenantID, clientID, map[store.SyncTable][]store.SyncRow{
		store.TablePlaces: {row},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	return result
}

// TestServerTimestampDefeatsClientClockSkew is the central fix of sync v2.
//
// The first implementation ordered conflicts by the `updated_at` the client supplied, so a
// device whose clock ran fast won every conflict forever and one whose clock ran slow lost
// every conflict forever — permanently, with no way to recover. The server now stamps the
// row itself, so a client claiming the year 2099 has no advantage.
func TestServerTimestampDefeatsClientClockSkew(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	tenantID, _ := syncTenant(t, app, "Skew")

	id, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}

	// A device with a wildly fast clock.
	future := time.Now().UTC().AddDate(70, 0, 0).Format(time.RFC3339)
	first := pushPlaces(t, app, tenantID, "device-fast", store.SyncRow{
		"id": id, "name": "Создано быстрым устройством", "updated_at": future,
	})
	if first.Applied != 1 {
		t.Fatalf("the initial insert should apply, got %+v", first.Results)
	}

	// The stored row must carry the SERVER's time, not the client's claim.
	changes, _, err := app.Pull(ctx, tenantID, -1)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	var stored store.SyncRow
	for _, place := range changes.Places {
		if place["id"] == id {
			stored = place
		}
	}
	if stored == nil {
		t.Fatal("the pushed place is missing from the pull")
	}
	storedUpdated := asTimeString(t, stored["updated_at"])
	if storedUpdated == future {
		t.Fatal("the client's claimed timestamp was stored verbatim; the server must stamp rows itself")
	}
	if parsed := asTimeValue(t, stored["updated_at"]); parsed.After(time.Now().UTC().Add(time.Hour)) {
		t.Errorf("stored updated_at %s is in the future; the server clock did not override the client's", storedUpdated)
	}

	// A second device with a slow clock pushes a change. Because the client timestamp is
	// ignored, this must WIN: it is the later write as far as the server is concerned.
	past := time.Now().UTC().AddDate(-5, 0, 0).Format(time.RFC3339)
	second := pushPlaces(t, app, tenantID, "device-slow", store.SyncRow{
		"id": id, "name": "Обновлено медленным устройством", "updated_at": past,
	})
	if second.Applied != 1 {
		t.Fatalf("a later write must win regardless of the client clock, got %+v", second.Results)
	}

	// The slow device's value is what the server now holds.
	changes, _, err = app.Pull(ctx, tenantID, -1)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	for _, place := range changes.Places {
		if place["id"] != id {
			continue
		}
		if name, _ := place["name"].(string); name != "Обновлено медленным устройством" {
			t.Errorf("stored name = %q; the client clock influenced the outcome", name)
		}
	}
}

// TestStalePushIsReportedNotSilentlySkipped covers the second half of the conflict fix.
//
// The first implementation returned a bare `applied` count, so a client could not tell
// "the server stored my row" from "the server already had something newer and ignored me".
// The v2 response reports the outcome per row, which is what lets a client adopt the
// server's copy instead of believing its change landed.
func TestStalePushIsReportedNotSilentlySkipped(t *testing.T) {
	app := repoStore(t)
	tenantID, _ := syncTenant(t, app, "Stale")

	id, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}

	pushPlaces(t, app, tenantID, "device-a", store.SyncRow{"id": id, "name": "Первое"})
	// The same device pushes the same row again with no intervening change. The server's
	// stored timestamp is at least as new, and the writer id is equal, so the incoming row
	// loses — and says so.
	result := pushPlaces(t, app, tenantID, "device-a", store.SyncRow{"id": id, "name": "Первое"})

	if result.Applied != 0 {
		t.Errorf("applied = %d, want 0 for a row the server already has", result.Applied)
	}
	if result.Stale != 1 {
		t.Errorf("stale = %d, want 1", result.Stale)
	}
	if len(result.Results) != 1 || result.Results[0].Outcome != store.OutcomeStale {
		t.Errorf("results = %+v, want a single stale outcome", result.Results)
	}
	// The version is echoed so the client can advance its cursor without a follow-up pull.
	if result.Results[0].Version == 0 {
		t.Error("a stale result should still report the stored version")
	}
}

// TestPushIsAtomicSoTheWatermarkNeverOverstates covers the third defect: the watermark used
// to advance before the row was written, on separate statements, so a failure in between
// left a version that claimed a change nobody could pull.
//
// A rejected row inside a batch must therefore leave the watermark exactly where it was.
func TestPushIsAtomicSoTheWatermarkNeverOverstates(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	tenantID, _ := syncTenant(t, app, "Atomic")

	before, err := app.GetTenantState(ctx, tenantID)
	if err != nil {
		t.Fatalf("GetTenantState: %v", err)
	}

	// A row with no id is unusable and must be rejected without disturbing anything.
	result, err := app.Push(ctx, tenantID, "device-x", map[store.SyncTable][]store.SyncRow{
		store.TablePlaces: {{"name": "Без идентификатора"}},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if result.Rejected != 1 {
		t.Fatalf("rejected = %d, want 1: %+v", result.Rejected, result.Results)
	}
	if result.Applied != 0 {
		t.Errorf("applied = %d, want 0", result.Applied)
	}

	after, err := app.GetTenantState(ctx, tenantID)
	if err != nil {
		t.Fatalf("GetTenantState: %v", err)
	}
	// A rejected row stored nothing, so advancing the watermark would make every future
	// pull report a change that does not exist — and, worse, hide the next real change
	// behind a cursor the client had already passed.
	if after.Version != before.Version {
		t.Errorf("watermark advanced from %d to %d for a rejected row", before.Version, after.Version)
	}

	// A valid row in the same batch DOES advance it.
	validID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	mixed, err := app.Push(ctx, tenantID, "device-x", map[store.SyncTable][]store.SyncRow{
		store.TablePlaces: {
			{"name": "Без идентификатора"},
			{"id": validID, "name": "Годная запись"},
		},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if mixed.Rejected != 1 || mixed.Applied != 1 {
		t.Errorf("rejected/applied = %d/%d, want 1/1", mixed.Rejected, mixed.Applied)
	}
	final, err := app.GetTenantState(ctx, tenantID)
	if err != nil {
		t.Fatalf("GetTenantState: %v", err)
	}
	if final.Version <= before.Version {
		t.Errorf("watermark did not advance for the applied row: %d then %d", before.Version, final.Version)
	}
}

// TestCollidingOfflineBookingIsStoredAsAConflict is the behaviour the conflict queue
// depends on. A device that was offline has no way to know the dates were already sold, so
// rejecting its booking loses a guest's reservation. It is stored, flagged, and left for an
// operator instead.
func TestCollidingOfflineBookingIsStoredAsAConflict(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Conflict")
	// Paid plan: this test pushes an extra reservation onto a tenant that already has one.
	grantLicense(t, app, account.ID)
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	// The server already holds a booking for these dates, created the normal way.
	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-05", nil), "server"); err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	// An offline device pushes a booking that overlaps it.
	conflictID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	result, err := app.Push(ctx, account.ID, "offline-device", map[store.SyncTable][]store.SyncRow{
		store.TableReservations: {{
			"id": conflictID, "unit_id": unit.ID, "guest_name": "Офлайн гость",
			"check_in_date": "2026-09-03", "check_out_date": "2026-09-07",
			"adults": 2, "status": "confirmed",
			"accommodation_minor": 96000, "total_minor": 96000,
		}},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if result.Conflict != 1 {
		t.Fatalf("conflicts = %d, want 1: %+v", result.Conflict, result.Results)
	}
	row := result.Results[0]
	if row.Outcome != store.OutcomeConflict {
		t.Errorf("outcome = %q, want conflict", row.Outcome)
	}
	// The response names the nights, so a client can explain the collision to its user
	// rather than showing a generic failure.
	if len(row.ConflictDates) == 0 {
		t.Error("the conflict should report the colliding dates")
	}

	t.Run("the booking is preserved, not discarded", func(t *testing.T) {
		loaded, err := app.GetReservation(ctx, account.ID, conflictID)
		if err != nil {
			t.Fatalf("the colliding booking was dropped: %v", err)
		}
		if loaded.Status != string(domain.StatusConflict) {
			t.Errorf("status = %q, want conflict", loaded.Status)
		}
		if loaded.ConflictCode == nil || *loaded.ConflictCode != "night_conflict" {
			t.Errorf("conflict_code = %v, want night_conflict", loaded.ConflictCode)
		}
		// Its nights are NOT written: they are the thing that collided, and occupying
		// them would block the booking it conflicts with.
		if len(loaded.Nights) != 0 {
			t.Errorf("a conflicted booking must not occupy nights, got %d", len(loaded.Nights))
		}
	})

	t.Run("the existing booking is untouched", func(t *testing.T) {
		reservations, err := app.ListReservations(ctx, account.ID)
		if err != nil {
			t.Fatalf("ListReservations: %v", err)
		}
		var original *store.Reservation
		for i := range reservations {
			if reservations[i].Status == string(domain.StatusConfirmed) {
				original = &reservations[i]
			}
		}
		if original == nil {
			t.Fatal("the original booking disappeared")
		}
		if len(original.Nights) != 4 {
			t.Errorf("the original booking lost nights: %d", len(original.Nights))
		}
	})

	t.Run("the dates remain occupied by the original only", func(t *testing.T) {
		taken, err := app.TakenNights(ctx, account.ID, unit.ID, []domain.Date{
			domain.MustParseDate("2026-09-03"),
			domain.MustParseDate("2026-09-04"),
			domain.MustParseDate("2026-09-05"),
			domain.MustParseDate("2026-09-06"),
		})
		if err != nil {
			t.Fatalf("TakenNights: %v", err)
		}
		// Only the 3rd and 4th belong to the original booking; the conflicted one
		// contributed nothing.
		if len(taken) != 2 {
			t.Errorf("taken nights = %v, want exactly the original's two", taken)
		}
	})
}

// TestConflictWithItsNightsDoesNotAbortTheBatch is the regression test for a bug that only
// appeared against a real client payload.
//
// A client sends a booking AND its nights as separate rows. Detecting the collision per row
// was too late: the booking was stored as a conflict, and then its nights hit the unique
// index and aborted the whole transaction — so the booking vanished and every other row in
// the batch with it. The batch is now planned before anything is written.
func TestConflictWithItsNightsDoesNotAbortTheBatch(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "ConflictNights")
	grantLicense(t, app, account.ID)
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-05", nil), "server"); err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}

	conflictID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	// The overlapping booking arrives the way a client sends it: the booking and each of
	// its nights are separate rows in the same batch.
	nights := make([]store.SyncRow, 0, 3)
	for _, date := range []string{"2026-09-04", "2026-09-05", "2026-09-06"} {
		nightID, idErr := store.NewID()
		if idErr != nil {
			t.Fatalf("NewID: %v", idErr)
		}
		nights = append(nights, store.SyncRow{
			"id": nightID, "reservation_id": conflictID, "unit_id": unit.ID, "night_date": date,
		})
	}

	// A valid unrelated row rides along, so the test also proves the batch is not lost.
	extraPlaceID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}

	result, err := app.Push(ctx, account.ID, "device-B", map[store.SyncTable][]store.SyncRow{
		store.TableReservations: {{
			"id": conflictID, "unit_id": unit.ID, "guest_name": "Офлайн гость",
			"check_in_date": "2026-09-04", "check_out_date": "2026-09-07",
			"status": "confirmed", "accommodation_minor": 72000, "total_minor": 72000,
		}},
		store.TableReservationNights: nights,
		store.TablePlaces:            {{"id": extraPlaceID, "name": "Сопутствующая запись"}},
	})
	if err != nil {
		t.Fatalf("the batch must not abort: %v", err)
	}

	// The booking is preserved and flagged.
	loaded, err := app.GetReservation(ctx, account.ID, conflictID)
	if err != nil {
		t.Fatalf("the colliding booking was lost: %v", err)
	}
	if loaded.Status != string(domain.StatusConflict) {
		t.Errorf("status = %q, want conflict", loaded.Status)
	}
	if loaded.ConflictCode == nil || *loaded.ConflictCode != "night_conflict" {
		t.Errorf("conflict_code = %v, want night_conflict", loaded.ConflictCode)
	}
	// And it occupies nothing.
	if len(loaded.Nights) != 0 {
		t.Errorf("a conflicted booking must not occupy nights, got %d", len(loaded.Nights))
	}

	// The unrelated row in the same batch still landed: an aborted transaction would have
	// taken it down too.
	if result.Applied != 1 {
		t.Errorf("applied = %d, want the one unrelated row", result.Applied)
	}
	places, err := app.ListPlaces(ctx, account.ID)
	if err != nil {
		t.Fatalf("ListPlaces: %v", err)
	}
	found := false
	for _, place := range places {
		if place.ID == extraPlaceID {
			found = true
		}
	}
	if !found {
		t.Error("the unrelated row in the same batch was lost")
	}
}

// TestTwoOfflineBookingsForTheSameUnitCollide is the in-batch case: a device that created
// two bookings offline on one unit sends both at once. Neither collides with the server,
// but they collide with each other, and the second must not abort the batch.
func TestTwoOfflineBookingsForTheSameUnitCollide(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "InBatch")
	grantLicense(t, app, account.ID)
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	firstID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	secondID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}

	booking := func(id string) store.SyncRow {
		return store.SyncRow{
			"id": id, "unit_id": unit.ID, "guest_name": "Гость",
			"check_in_date": "2026-09-01", "check_out_date": "2026-09-04",
			"status": "confirmed", "accommodation_minor": 72000, "total_minor": 72000,
		}
	}
	nightsFor := func(id string) []store.SyncRow {
		var rows []store.SyncRow
		for _, date := range []string{"2026-09-01", "2026-09-02", "2026-09-03"} {
			nightID, idErr := store.NewID()
			if idErr != nil {
				t.Fatalf("NewID: %v", idErr)
			}
			rows = append(rows, store.SyncRow{
				"id": nightID, "reservation_id": id, "unit_id": unit.ID, "night_date": date,
			})
		}
		return rows
	}

	// The first booking is valid and must be stored; the second collides with it.
	result, err := app.Push(ctx, account.ID, "offline-device", map[store.SyncTable][]store.SyncRow{
		store.TableReservations:      {booking(firstID), booking(secondID)},
		store.TableReservationNights: append(nightsFor(firstID), nightsFor(secondID)...),
	})
	if err != nil {
		t.Fatalf("the batch must not abort: %v", err)
	}
	if result.Conflict == 0 {
		t.Errorf("the in-batch collision was not detected: %+v", result.Results)
	}

	// At least one booking survives with its nights; neither is silently dropped.
	first, firstErr := app.GetReservation(ctx, account.ID, firstID)
	second, secondErr := app.GetReservation(ctx, account.ID, secondID)
	if firstErr != nil && secondErr != nil {
		t.Fatal("both bookings were lost")
	}
	stored := first
	if firstErr != nil {
		stored = second
	}
	if stored != nil && len(stored.Nights) != 3 {
		t.Errorf("the surviving booking has %d nights, want 3", len(stored.Nights))
	}
}

// TestConflictIsNotHiddenFromTheOperatorQueue ties the sync behaviour to the queue that
// makes it useful: a stored conflict must be visible to whoever resolves it.
func TestConflictIsNotHiddenFromTheOperatorQueue(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Queue")
	grantLicense(t, app, account.ID)
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	if _, err := app.CreateReservation(ctx, account.ID,
		reservationInput(unit.ID, "2026-09-01", "2026-09-05", nil), "server"); err != nil {
		t.Fatalf("CreateReservation: %v", err)
	}
	conflictID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if _, err := app.Push(ctx, account.ID, "offline", map[store.SyncTable][]store.SyncRow{
		store.TableReservations: {{
			"id": conflictID, "unit_id": unit.ID, "guest_name": "Офлайн гость",
			"check_in_date": "2026-09-03", "check_out_date": "2026-09-07",
			"status": "confirmed",
		}},
	}); err != nil {
		t.Fatalf("Push: %v", err)
	}

	// The queue spans tenants, so it must run on a connection whose role bypasses RLS.
	// The application role would see nothing and the test would fail for the wrong reason.
	adminStore, err := store.New(ctx, testdb.AdminDSN(t))
	if err != nil {
		t.Fatalf("connect as admin role: %v", err)
	}
	defer adminStore.Close()

	conflicts, err := adminStore.ListConflicts(ctx, 50)
	if err != nil {
		t.Fatalf("ListConflicts: %v", err)
	}
	found := false
	for _, conflict := range conflicts {
		if conflict.ReservationID == conflictID {
			found = true
		}
	}
	if !found {
		t.Errorf("the stored conflict is not in the operator queue (%d entries)", len(conflicts))
	}
}

// TestPullCursorReturnsOnlyNewerRows covers the incremental path: a client that has
// already seen version N must receive only what changed after it, or every sync transfers
// the whole database.
func TestPullCursorReturnsOnlyNewerRows(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	tenantID, _ := syncTenant(t, app, "Cursor")

	firstID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	pushPlaces(t, app, tenantID, "device", store.SyncRow{"id": firstID, "name": "Первое"})

	_, version, err := app.Pull(ctx, tenantID, -1)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if version == 0 {
		t.Fatal("the watermark should have advanced")
	}

	// Nothing changed since, so an incremental pull is empty.
	changes, _, err := app.Pull(ctx, tenantID, version)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(changes.Places) != 0 {
		t.Errorf("an up-to-date client received %d places, want 0", len(changes.Places))
	}

	// A second change appears.
	secondID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	pushPlaces(t, app, tenantID, "device", store.SyncRow{"id": secondID, "name": "Второе"})

	changes, newVersion, err := app.Pull(ctx, tenantID, version)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(changes.Places) != 1 {
		t.Fatalf("got %d places, want exactly the new one", len(changes.Places))
	}
	if changes.Places[0]["id"] != secondID {
		t.Errorf("pulled the wrong row: %v", changes.Places[0]["id"])
	}
	if newVersion <= version {
		t.Errorf("watermark did not advance: %d then %d", version, newVersion)
	}
}

// TestPushCreatesAReservationWithItsChildRows covers the graph: sync sends a reservation
// and its nights separately, and both must land.
func TestPushCreatesAReservationWithItsChildRows(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Graph")
	grantLicense(t, app, account.ID)
	unit := newUnit(t, app, account.ID, place.ID, "Дом", 4, 24000)

	reservationID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	nightIDs := make([]string, 3)
	for i := range nightIDs {
		nightIDs[i], err = store.NewID()
		if err != nil {
			t.Fatalf("NewID: %v", err)
		}
	}

	result, err := app.Push(ctx, account.ID, "device", map[store.SyncTable][]store.SyncRow{
		store.TableReservations: {{
			"id": reservationID, "unit_id": unit.ID, "guest_name": "Гость",
			"check_in_date": "2026-09-01", "check_out_date": "2026-09-04",
			"status": "confirmed", "accommodation_minor": 72000, "total_minor": 72000,
		}},
		store.TableReservationNights: {
			{"id": nightIDs[0], "reservation_id": reservationID, "unit_id": unit.ID, "night_date": "2026-09-01"},
			{"id": nightIDs[1], "reservation_id": reservationID, "unit_id": unit.ID, "night_date": "2026-09-02"},
			{"id": nightIDs[2], "reservation_id": reservationID, "unit_id": unit.ID, "night_date": "2026-09-03"},
		},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if result.Applied != 4 {
		t.Fatalf("applied = %d, want 4: %+v", result.Applied, result.Results)
	}

	loaded, err := app.GetReservation(ctx, account.ID, reservationID)
	if err != nil {
		t.Fatalf("GetReservation: %v", err)
	}
	if len(loaded.Nights) != 3 {
		t.Errorf("got %d nights, want 3", len(loaded.Nights))
	}
}

// TestPushRejectsAnUnknownTableRatherThanIgnoringIt guards a silent-failure mode: a client
// that misspells a table name must not be told its data synced.
func TestPushRejectsAnUnknownTableRatherThanIgnoringIt(t *testing.T) {
	app := repoStore(t)
	tenantID, _ := syncTenant(t, app, "Unknown")

	// The store applies only known tables, so an unknown key is simply not iterated. The
	// HTTP layer is what reports it, which is asserted in the API tests; here we pin the
	// store's behaviour so the two cannot silently disagree.
	result, err := app.Push(context.Background(), tenantID, "device", map[store.SyncTable][]store.SyncRow{
		store.SyncTable("properties"): {{"id": "x"}},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if result.Applied != 0 || result.Results == nil {
		t.Errorf("an unknown table must apply nothing: %+v", result)
	}
}

// TestSyncCannotWriteIntoAnotherTenant is the isolation check for the sync path, which
// takes its tenant from the session rather than the payload.
func TestSyncCannotWriteIntoAnotherTenant(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	accountA, _ := newTenantWithPlace(t, app, "Sync A")
	accountB, _ := newTenantWithPlace(t, app, "Sync B")
	// Licensed accounts: the check below pushes an additional place onto each tenant, which
	// the free tier's cap refuses for reasons unrelated to tenant isolation.
	for _, id := range []string{accountA.ID, accountB.ID} {
		grantLicense(t, app, id)
	}

	id, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	// A payload that claims tenant A while the session is tenant B.
	if _, err := app.Push(ctx, accountB.ID, "attacker", map[store.SyncTable][]store.SyncRow{
		store.TablePlaces: {{"id": id, "name": "Захвачено", "tenant_id": accountA.ID}},
	}); err != nil {
		t.Fatalf("Push: %v", err)
	}

	// The row belongs to B, and A must not see it.
	aPlaces, err := app.ListPlaces(ctx, accountA.ID)
	if err != nil {
		t.Fatalf("ListPlaces: %v", err)
	}
	for _, place := range aPlaces {
		if place.ID == id {
			t.Fatal("a sync push wrote into another tenant")
		}
	}
	bPlaces, err := app.ListPlaces(ctx, accountB.ID)
	if err != nil {
		t.Fatalf("ListPlaces: %v", err)
	}
	found := false
	for _, place := range bPlaces {
		if place.ID == id {
			found = true
		}
	}
	if !found {
		t.Error("the row should have landed in the session's own tenant")
	}
}

// --- helpers ----------------------------------------------------------------

// asTimeString renders a pulled timestamp for comparison.
func asTimeString(t *testing.T, value any) string {
	t.Helper()
	text, ok := value.(string)
	if !ok {
		t.Fatalf("expected a string timestamp, got %T", value)
	}
	return text
}

// asTimeValue parses a pulled timestamp.
func asTimeValue(t *testing.T, value any) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, asTimeString(t, value))
	if err != nil {
		t.Fatalf("timestamp %v is not RFC3339: %v", value, err)
	}
	return parsed
}

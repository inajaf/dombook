package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/inajaf/dombook/server/internal/admin"
	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/inajaf/dombook/server/internal/testdb"
)

// The admin surface is the one place that reads across tenants, so its tests focus on the
// properties that make that acceptable: the key is required and compared safely, the
// surface cannot be reached without it, and the data it exposes is accurate.

const testAdminKey = "admin-test-key-long-enough-to-pass"

// adminHarness builds the admin router against a real database, plus a customer-role
// store for seeding.
func adminHarness(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	testdb.Prepare(t)
	testdb.ResetData(t)

	// The admin router runs on the BYPASSRLS connection, mirroring production where the
	// operator role is a separate credential.
	adminStore, err := store.New(context.Background(), testdb.DSN(t))
	if err != nil {
		t.Fatalf("connect as admin role: %v", err)
	}
	t.Cleanup(adminStore.Close)

	server := httptest.NewServer(admin.Server(admin.Deps{Store: adminStore, APIKey: testAdminKey}))
	t.Cleanup(server.Close)

	// Tenant data is seeded through the unprivileged role, so the fixture itself cannot
	// accidentally rely on bypassing RLS.
	appStore, err := store.New(context.Background(), testdb.AppDSN(t))
	if err != nil {
		t.Fatalf("connect as application role: %v", err)
	}
	t.Cleanup(appStore.Close)

	return server, appStore
}

// adminCall performs a request against the admin surface.
func adminCall(t *testing.T, server *httptest.Server, method, path, key string, body any) (int, map[string]any) {
	t.Helper()

	var reader *strings.Reader
	if body == nil {
		reader = strings.NewReader("")
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
		reader = strings.NewReader(string(encoded))
	}

	req, err := http.NewRequest(method, server.URL+path, reader)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()

	var decoded map[string]any
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		decoded = map[string]any{}
	}
	return response.StatusCode, decoded
}

// seedTenant creates an account with a place, a unit and a booking.
func seedTenant(t *testing.T, app *store.Store, name string, withBooking bool) *store.Account {
	t.Helper()
	ctx := context.Background()

	account, _, err := app.CreateAccountWithOwner(ctx, name, name+"-owner@example.test", "Owner", store.PlanFree)
	if err != nil {
		t.Fatalf("CreateAccountWithOwner: %v", err)
	}
	place, err := app.CreatePlace(ctx, account.ID, &domain.PlaceInput{
		Name: placeNameFor(name), HasFoodService: false, Status: "active",
	}, "test")
	if err != nil {
		t.Fatalf("CreatePlace: %v", err)
	}
	unit, err := app.CreateUnit(ctx, account.ID, &domain.UnitInput{
		PlaceID: &place.ID, Kind: "cottage", Name: unitNameFor(name), Capacity: 4,
		BasePriceMinor: 24000, Currency: "AZN", CheckInTime: "15:00", CheckOutTime: "11:00",
		Status: "active",
	}, "test")
	if err != nil {
		t.Fatalf("CreateUnit: %v", err)
	}

	if withBooking {
		checkIn := domain.MustParseDate("2026-09-01")
		checkOut := domain.MustParseDate("2026-09-04")
		nights, err := domain.Nights(checkIn, checkOut)
		if err != nil {
			t.Fatalf("Nights: %v", err)
		}
		if _, err := app.CreateReservation(ctx, account.ID, &domain.ReservationInput{
			UnitID: unit.ID, GuestName: "Гость", CheckIn: checkIn, CheckOut: checkOut,
			Nights: nights, Adults: 1, Status: domain.StatusConfirmed,
			NightlyRateMinor: 24000, AccommodationMinor: 72000, TotalMinor: 72000,
			DepositStatus: domain.DepositNone,
		}, "test"); err != nil {
			t.Fatalf("CreateReservation: %v", err)
		}
	}
	return account
}

// placeNameFor and unitNameFor keep names unique per account, since a name is unique
// per tenant while active.
func placeNameFor(name string) string { return "Дом " + name }
func unitNameFor(name string) string  { return "Объект " + name }

// --- authentication ---------------------------------------------------------

// TestEveryAdminRouteRequiresTheKey is the guard test. A single unguarded endpoint would
// expose every tenant's data, so the list is exhaustive rather than representative.
func TestEveryAdminRouteRequiresTheKey(t *testing.T) {
	server, _ := adminHarness(t)
	const missing = "00000000-0000-0000-0000-000000000000"

	routes := []struct{ method, path string }{
		{http.MethodGet, "/admin/health"},
		{http.MethodGet, "/admin/overview"},
		{http.MethodGet, "/admin/accounts"},
		{http.MethodGet, "/admin/accounts/" + missing},
		{http.MethodGet, "/admin/plans"},
		{http.MethodPatch, "/admin/accounts/" + missing + "/plan"},
		{http.MethodGet, "/admin/conflicts"},
		{http.MethodPost, "/admin/conflicts/" + missing + "/resolve"},
	}

	for _, route := range routes {
		t.Run(route.method+" "+route.path+" without a key", func(t *testing.T) {
			status, body := adminCall(t, server, route.method, route.path, "", nil)
			if status != http.StatusUnauthorized {
				t.Fatalf("returned %d, want 401: %v", status, body)
			}
		})

		t.Run(route.method+" "+route.path+" with a wrong key", func(t *testing.T) {
			status, _ := adminCall(t, server, route.method, route.path, "definitely-not-the-key", nil)
			if status != http.StatusUnauthorized {
				t.Fatalf("returned %d, want 401", status)
			}
		})
	}
}

// TestAKeyPrefixIsRejected covers the most likely way a constant-time comparison gets
// replaced by a shortcut: a prefix check that returns early. A key that is a prefix of the
// real one must be refused.
func TestAKeyPrefixIsRejected(t *testing.T) {
	server, _ := adminHarness(t)

	prefix := testAdminKey[:len(testAdminKey)-1]
	if status, _ := adminCall(t, server, http.MethodGet, "/admin/health", prefix, nil); status != http.StatusUnauthorized {
		t.Errorf("a key prefix returned %d, want 401", status)
	}
	// And a longer key that starts with the real one.
	if status, _ := adminCall(t, server, http.MethodGet, "/admin/health", testAdminKey+"x", nil); status != http.StatusUnauthorized {
		t.Errorf("an extended key returned %d, want 401", status)
	}
}

// TestUnconfiguredKeyDisablesTheSurface pins the fail-closed behaviour: a deployment that
// forgot the key must not expose the operator endpoints.
func TestUnconfiguredKeyDisablesTheSurface(t *testing.T) {
	testdb.Prepare(t)
	adminStore, err := store.New(context.Background(), testdb.DSN(t))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer adminStore.Close()

	// An empty key is what a misconfigured deployment would have.
	server := httptest.NewServer(admin.Server(admin.Deps{Store: adminStore, APIKey: ""}))
	defer server.Close()

	// Even presenting an empty token must not work.
	if status, _ := adminCall(t, server, http.MethodGet, "/admin/overview", "", nil); status != http.StatusUnauthorized {
		t.Errorf("an unconfigured key returned %d, want 401", status)
	}
	if status, _ := adminCall(t, server, http.MethodGet, "/admin/overview", " ", nil); status != http.StatusUnauthorized {
		t.Errorf("a blank token returned %d, want 401", status)
	}
}

// --- health and overview ----------------------------------------------------

func TestHealthAndOverview(t *testing.T) {
	server, app := adminHarness(t)
	seedTenant(t, app, "Alpha", true)
	seedTenant(t, app, "Beta", false)

	t.Run("health reports the account count", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodGet, "/admin/health", testAdminKey, nil)
		if status != http.StatusOK {
			t.Fatalf("returned %d: %v", status, body)
		}
		if body["ok"] != true {
			t.Errorf("ok = %v, want true", body["ok"])
		}
		// Reaching this endpoint proves the admin connection works, which is a different
		// credential from the customer path and can fail independently.
		if body["accounts"] != float64(2) {
			t.Errorf("accounts = %v, want 2", body["accounts"])
		}
	})

	t.Run("overview counts every resource", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodGet, "/admin/overview", testAdminKey, nil)
		if status != http.StatusOK {
			t.Fatalf("returned %d: %v", status, body)
		}
		expected := map[string]float64{
			"accounts": 2, "users": 2, "places": 2, "units": 2, "reservations": 1,
		}
		for field, want := range expected {
			if body[field] != want {
				t.Errorf("%s = %v, want %v", field, body[field], want)
			}
		}
		breakdown, ok := body["plansBreakdown"].(map[string]any)
		if !ok {
			t.Fatalf("plansBreakdown missing: %v", body)
		}
		if breakdown["free"] != float64(2) {
			t.Errorf("plansBreakdown.free = %v, want 2", breakdown["free"])
		}
	})
}

// --- accounts ---------------------------------------------------------------

func TestAccountListingAndLookup(t *testing.T) {
	server, app := adminHarness(t)
	alpha := seedTenant(t, app, "Alpha", true)
	seedTenant(t, app, "Beta", false)

	t.Run("list includes per-account usage", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodGet, "/admin/accounts", testAdminKey, nil)
		if status != http.StatusOK {
			t.Fatalf("returned %d: %v", status, body)
		}
		accounts, ok := body["accounts"].([]any)
		if !ok {
			t.Fatalf("no accounts array: %v", body)
		}
		if len(accounts) != 2 {
			t.Fatalf("got %d accounts, want 2", len(accounts))
		}

		var alphaView map[string]any
		for _, raw := range accounts {
			account := raw.(map[string]any)
			if account["id"] == alpha.ID {
				alphaView = account
			}
		}
		if alphaView == nil {
			t.Fatal("the seeded account is missing from the list")
		}
		if alphaView["userCount"] != float64(1) {
			t.Errorf("userCount = %v, want 1", alphaView["userCount"])
		}
		if alphaView["unitCount"] != float64(1) || alphaView["placeCount"] != float64(1) {
			t.Errorf("places/units = %v/%v, want 1/1", alphaView["placeCount"], alphaView["unitCount"])
		}
		if alphaView["reservationCount"] != float64(1) {
			t.Errorf("reservationCount = %v, want 1", alphaView["reservationCount"])
		}
	})

	t.Run("single lookup", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodGet, "/admin/accounts/"+alpha.ID, testAdminKey, nil)
		if status != http.StatusOK {
			t.Fatalf("returned %d: %v", status, body)
		}
		if body["id"] != alpha.ID {
			t.Errorf("id = %v, want %s", body["id"], alpha.ID)
		}
		// The sync watermark is what lets an operator see whether a tenant is still
		// syncing or has stalled.
		if _, present := body["syncVersion"]; !present {
			t.Error("syncVersion missing")
		}
	})

	t.Run("unknown account is a 404", func(t *testing.T) {
		status, _ := adminCall(t, server, http.MethodGet,
			"/admin/accounts/00000000-0000-0000-0000-000000000000", testAdminKey, nil)
		if status != http.StatusNotFound {
			t.Errorf("returned %d, want 404", status)
		}
	})
}

func TestAdminCanChangeAPlan(t *testing.T) {
	server, app := adminHarness(t)
	account := seedTenant(t, app, "Upgrade", false)

	status, body := adminCall(t, server, http.MethodPatch, "/admin/accounts/"+account.ID+"/plan",
		testAdminKey, map[string]any{"plan": "business"})
	if status != http.StatusOK {
		t.Fatalf("returned %d: %v", status, body)
	}
	if body["plan"] != "business" {
		t.Errorf("plan = %v, want business", body["plan"])
	}

	t.Run("an unknown plan is refused", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodPatch, "/admin/accounts/"+account.ID+"/plan",
			testAdminKey, map[string]any{"plan": "enterprise"})
		if status != http.StatusBadRequest {
			t.Fatalf("returned %d, want 400: %v", status, body)
		}
		errorObject := body["error"].(map[string]any)
		if errorObject["code"] != "validation_error" {
			t.Errorf("code = %v, want validation_error", errorObject["code"])
		}
		// Validating before the update matters: an unknown value must not reach the
		// database and become a CHECK violation the operator cannot interpret.
		_, detail := adminCall(t, server, http.MethodGet, "/admin/accounts/"+account.ID, testAdminKey, nil)
		if detail["plan"] != "business" {
			t.Errorf("plan changed to %v despite the rejection", detail["plan"])
		}
	})
}

func TestPlanCatalogReportsAccountCounts(t *testing.T) {
	server, app := adminHarness(t)
	seedTenant(t, app, "One", false)
	seedTenant(t, app, "Two", false)

	status, body := adminCall(t, server, http.MethodGet, "/admin/plans", testAdminKey, nil)
	if status != http.StatusOK {
		t.Fatalf("returned %d: %v", status, body)
	}
	plans, ok := body["plans"].([]any)
	if !ok {
		t.Fatalf("no plans array: %v", body)
	}
	if len(plans) != 3 {
		t.Fatalf("got %d plans, want 3", len(plans))
	}

	for _, raw := range plans {
		plan := raw.(map[string]any)
		if plan["id"] == "free" {
			if plan["accountCount"] != float64(2) {
				t.Errorf("free accountCount = %v, want 2", plan["accountCount"])
			}
			// The cap is per bookable unit, which is the licensing model's point: a free
			// account gets one unit, not one guest house full of cottages.
			if plan["maxUnits"] != "1" {
				t.Errorf("free maxUnits = %v, want 1", plan["maxUnits"])
			}
		}
		if plan["id"] == "business" && plan["maxUnits"] != "unlimited" {
			t.Errorf("business maxUnits = %v, want unlimited", plan["maxUnits"])
		}
	}
}

// --- conflicts --------------------------------------------------------------

// TestConflictQueueSurfacesUnresolvedCollisions covers the queue that makes the
// conflict-status design useful: a booking that could not be applied is stored, and an
// operator can see it and mark it handled.
func TestConflictQueueSurfacesUnresolvedCollisions(t *testing.T) {
	server, app := adminHarness(t)
	account := seedTenant(t, app, "Conflicted", true)

	// No conflicts yet.
	status, body := adminCall(t, server, http.MethodGet, "/admin/conflicts", testAdminKey, nil)
	if status != http.StatusOK {
		t.Fatalf("returned %d: %v", status, body)
	}
	if conflicts, _ := body["conflicts"].([]any); len(conflicts) != 0 {
		t.Fatalf("expected no conflicts, got %d", len(conflicts))
	}

	// Mark the existing booking as conflicted, which is what the sync path does when an
	// offline booking collides with a stay the server already has.
	reservationID := markConflict(t, app, account.ID)

	status, body = adminCall(t, server, http.MethodGet, "/admin/conflicts", testAdminKey, nil)
	if status != http.StatusOK {
		t.Fatalf("returned %d: %v", status, body)
	}
	conflicts, _ := body["conflicts"].([]any)
	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(conflicts))
	}
	conflict := conflicts[0].(map[string]any)
	if conflict["reservationId"] != reservationID {
		t.Errorf("reservationId = %v, want %s", conflict["reservationId"], reservationID)
	}
	if conflict["conflictCode"] != "night_conflict" {
		t.Errorf("conflictCode = %v, want night_conflict", conflict["conflictCode"])
	}
	// The account name lets an operator see whose booking needs attention without a
	// second lookup.
	if conflict["accountName"] == "" {
		t.Error("accountName should be populated")
	}

	t.Run("resolution requires a decision", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodPost,
			"/admin/conflicts/"+reservationID+"/resolve", testAdminKey, map[string]any{"resolution": ""})
		if status != http.StatusBadRequest {
			t.Fatalf("returned %d, want 400: %v", status, body)
		}
	})

	t.Run("resolving removes it from the queue", func(t *testing.T) {
		status, body := adminCall(t, server, http.MethodPost,
			"/admin/conflicts/"+reservationID+"/resolve", testAdminKey,
			map[string]any{"resolution": "rebooked on another unit"})
		if status != http.StatusOK {
			t.Fatalf("returned %d: %v", status, body)
		}

		status, body = adminCall(t, server, http.MethodGet, "/admin/conflicts", testAdminKey, nil)
		if status != http.StatusOK {
			t.Fatalf("returned %d: %v", status, body)
		}
		if conflicts, _ := body["conflicts"].([]any); len(conflicts) != 0 {
			t.Errorf("a resolved conflict is still queued: %d", len(conflicts))
		}
	})

	t.Run("resolving an unknown conflict is a 404", func(t *testing.T) {
		status, _ := adminCall(t, server, http.MethodPost,
			"/admin/conflicts/00000000-0000-0000-0000-000000000000/resolve", testAdminKey,
			map[string]any{"resolution": "x"})
		if status != http.StatusNotFound {
			t.Errorf("returned %d, want 404", status)
		}
	})
}

// markConflict flags a reservation as conflicted, standing in for the sync path that will
// do this when an offline push collides. It uses the admin connection because setting the
// column is not exposed through the customer API — a client must not be able to mark its
// own booking conflicted and hide it from the queue.
func markConflict(t *testing.T, app *store.Store, accountID string) string {
	t.Helper()
	reservations, err := app.ListReservations(context.Background(), accountID)
	if err != nil {
		t.Fatalf("ListReservations: %v", err)
	}
	if len(reservations) == 0 {
		t.Fatal("no reservation to flag")
	}
	id := reservations[0].ID

	pool, err := store.OpenPool(context.Background(), testdb.DSN(t))
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(context.Background(), `
		UPDATE reservations
		SET conflict_code = 'night_conflict',
		    conflict_details = jsonb_build_object('dates', jsonb_build_array('2026-09-02'))
		WHERE id = $1`, id); err != nil {
		t.Fatalf("flag conflict: %v", err)
	}
	return id
}

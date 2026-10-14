package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Sync endpoint tests. These cover the wire contract rather than the merge logic, which
// internal/store owns: the cursor round trip, the per-row outcome reporting, and the
// guards. What matters at this level is that a client can actually converge using nothing
// but these two endpoints.

// syncSetup returns a domain server, a token, and a unit to book against.
//
// The sleep is load-bearing, not padding. The server decides which of two copies of a row
// wins by comparing the incoming push's server-side timestamp against the stored
// `updated_at`, and treats "not strictly newer" as a STALE outcome the client must adopt.
// This setup creates the unit and the test immediately pushes a modification of it, so under
// load both can land inside the SAME microsecond — PostgreSQL stores timestamptz at
// microsecond precision, so the later write is then not strictly newer and the push is
// rejected as stale. The symptom is three sync tests failing together and passing on rerun;
// it was first seen when the whole suite ran with -race.
//
// A millisecond is three orders of magnitude larger than the clock's precision, so it costs
// nothing measurable and removes the race rather than the assertion.
func syncSetup(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Синхронизация")
	unitID := createUnitForTest(t, server, token, placeID, "Коттедж")
	time.Sleep(time.Millisecond)
	return server, token, unitID
}

// push posts a sync batch and returns the decoded response.
func push(t *testing.T, server *httptest.Server, token, clientID string, changes map[string]any) (int, map[string]any) {
	t.Helper()
	return request(t, server, http.MethodPost, "/sync/push", token, map[string]any{
		"clientId": clientID,
		"changes":  changes,
	})
}

// pull reads changes after a cursor.
func pull(t *testing.T, server *httptest.Server, token string, since int64) (int, map[string]any) {
	t.Helper()
	path := "/sync/pull?since=" + itoa(since)
	return request(t, server, http.MethodGet, path, token, nil)
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

// cursorOf digs the watermark out of a sync response.
func cursorOf(t *testing.T, body map[string]any) int64 {
	t.Helper()
	state, ok := body["state"].(map[string]any)
	if !ok {
		t.Fatalf("response has no state object: %v", body)
	}
	version, ok := state["version"].(float64)
	if !ok {
		t.Fatalf("state has no numeric version: %v", state)
	}
	return int64(version)
}

// TestSyncCursorRoundTrip is the basic convergence loop: push a change, then pull it back
// using the cursor the push returned.
func TestSyncCursorRoundTrip(t *testing.T) {
	server, token, unitID := syncSetup(t)

	// Push a unit change and read the cursor the server reports.
	status, body := push(t, server, token, "device-a", map[string]any{
		"units": []any{
			map[string]any{"id": unitID, "name": "Коттедж переименован", "capacity": 4},
		},
	})
	if status != http.StatusOK {
		t.Fatalf("push returned %d: %v", status, body)
	}
	if body["applied"] != float64(1) {
		t.Fatalf("applied = %v, want 1: %v", body["applied"], body["results"])
	}
	pushCursor := cursorOf(t, body)
	if pushCursor == 0 {
		t.Fatal("the push should report an advanced cursor")
	}

	// Pulling with that cursor yields nothing: the client is up to date.
	status, empty := pull(t, server, token, pushCursor)
	if status != http.StatusOK {
		t.Fatalf("pull returned %d: %v", status, empty)
	}
	changes := empty["changes"].(map[string]any)
	if len(changes["units"].([]any)) != 0 {
		t.Errorf("an up-to-date client received %d units", len(changes["units"].([]any)))
	}

	// Pulling from the beginning yields the row.
	status, all := pull(t, server, token, 0)
	if status != http.StatusOK {
		t.Fatalf("pull returned %d: %v", status, all)
	}
	allChanges := all["changes"].(map[string]any)
	units := allChanges["units"].([]any)
	if len(units) == 0 {
		t.Fatal("a full pull returned no units")
	}
	found := false
	for _, raw := range units {
		if raw.(map[string]any)["id"] == unitID {
			found = true
		}
	}
	if !found {
		t.Error("the pushed unit is missing from a full pull")
	}
}

// TestPushReportsPerRowOutcomes is the contract that lets a client tell "stored" from
// "your change lost" from "this needs a human". A bare count cannot express that, which is
// exactly the defect v2 fixes.
func TestPushReportsPerRowOutcomes(t *testing.T) {
	server, token, unitID := syncSetup(t)

	// One valid row and one unusable row in the same batch.
	status, body := push(t, server, token, "device-a", map[string]any{
		"units": []any{
			map[string]any{"name": "Без идентификатора"},
			map[string]any{"id": unitID, "name": "Годная запись", "capacity": 4},
		},
	})
	if status != http.StatusOK {
		t.Fatalf("push returned %d: %v", status, body)
	}

	results, ok := body["results"].([]any)
	if !ok {
		t.Fatalf("response has no results array: %v", body)
	}
	if len(results) != 2 {
		t.Fatalf("got %d results for 2 rows", len(results))
	}

	outcomes := map[string]int{}
	for _, raw := range results {
		result := raw.(map[string]any)
		outcomes[result["outcome"].(string)]++
		// Each result names its table and row, so a client can attribute the outcome
		// without relying on ordering.
		if result["table"] == nil || result["id"] == nil {
			t.Errorf("a result is missing its table or id: %v", result)
		}
	}
	if outcomes["applied"] != 1 {
		t.Errorf("applied = %d, want 1", outcomes["applied"])
	}
	if outcomes["rejected"] != 1 {
		t.Errorf("rejected = %d, want 1", outcomes["rejected"])
	}
	// A rejection carries a stable reason code rather than localized prose, because sync
	// runs unattended and the client decides what to show.
	for _, raw := range results {
		result := raw.(map[string]any)
		if result["outcome"] == "rejected" && result["reason"] == "" {
			t.Error("a rejected row should carry a reason code")
		}
	}
}

// TestPushRejectsAnUnknownTable covers a silent-failure mode: a client that misspells a
// table must not be told its data synced.
func TestPushRejectsAnUnknownTable(t *testing.T) {
	server, token, _ := syncSetup(t)

	status, body := push(t, server, token, "device-a", map[string]any{
		"properties": []any{map[string]any{"id": "x"}},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("an unknown table returned %d, want 400: %v", status, body)
	}
	errorObject := body["error"].(map[string]any)
	if errorObject["code"] != "unknown_table" {
		t.Errorf("code = %v, want unknown_table", errorObject["code"])
	}
	// The response names the offending table so a client bug is obvious.
	details, _ := errorObject["details"].(map[string]any)
	if details == nil || details["table"] != "properties" {
		t.Errorf("details = %v, want table=properties", errorObject["details"])
	}
}

// TestSyncIsIdempotentUnderRetry is the property a mobile client depends on: a push whose
// response was lost must be safe to repeat.
func TestSyncIsIdempotentUnderRetry(t *testing.T) {
	server, token, unitID := syncSetup(t)

	changes := map[string]any{
		"units": []any{map[string]any{"id": unitID, "name": "Повтор", "capacity": 4}},
	}

	status, first := push(t, server, token, "device-a", changes)
	if status != http.StatusOK || first["applied"] != float64(1) {
		t.Fatalf("first push: %d %v", status, first)
	}
	firstCursor := cursorOf(t, first)

	// The client never saw the response and retries the identical batch.
	status, second := push(t, server, token, "device-a", changes)
	if status != http.StatusOK {
		t.Fatalf("retry returned %d: %v", status, second)
	}
	if second["applied"] != float64(0) {
		t.Errorf("a retried batch applied %v rows, want 0 — the retry must be free", second["applied"])
	}
	if second["stale"] != float64(1) {
		t.Errorf("stale = %v, want 1", second["stale"])
	}
	// And it did not advance the watermark, so no cursor is skipped.
	if cursorOf(t, second) != firstCursor {
		t.Errorf("a no-op retry advanced the cursor from %d to %d", firstCursor, cursorOf(t, second))
	}
}

// TestSyncRequiresAuthentication: sync moves the whole database, so an unguarded endpoint
// would expose every tenant's data.
func TestSyncRequiresAuthentication(t *testing.T) {
	server, _, _ := syncSetup(t)

	probes := []struct{ method, path string }{
		{http.MethodGet, "/sync/pull"},
		{http.MethodPost, "/sync/push"},
		{http.MethodGet, "/backups/export"},
	}
	for _, probe := range probes {
		status, _ := request(t, server, probe.method, probe.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Errorf("%s %s without a token returned %d, want 401", probe.method, probe.path, status)
		}
	}
}

// TestPullFullSnapshotForBackup covers the export path used by the desktop backup and by a
// client that lost its local database.
func TestPullFullSnapshotForBackup(t *testing.T) {
	server, token, unitID := syncSetup(t)

	// Book something so the snapshot has a reservation graph to carry.
	created := createReservation(t, server, token, unitID, datesFrom(5), datesFrom(8))

	status, body := request(t, server, http.MethodGet, "/backups/export", token, nil)
	if status != http.StatusOK {
		t.Fatalf("export returned %d: %v", status, body)
	}
	for _, field := range []string{"exportedAt", "schemaVersion", "accountId", "state", "data"} {
		if _, present := body[field]; !present {
			t.Errorf("export is missing %q", field)
		}
	}
	// A snapshot is a pull with no cursor, so it cannot drift from the incremental path.
	data := body["data"].(map[string]any)
	if len(data["units"].([]any)) == 0 {
		t.Error("the snapshot should include the unit")
	}
	reservations := data["reservations"].([]any)
	if len(reservations) == 0 {
		t.Fatal("the snapshot should include the reservation")
	}
	if len(data["reservation_nights"].([]any)) != 3 {
		t.Errorf("the snapshot should include the 3 nights, got %d", len(data["reservation_nights"].([]any)))
	}
	_ = created
}

// TestPullSinceTreatsAGarbageCursorAsFullResync: a client that sends an unparseable cursor
// is asking for everything. Erroring would leave it unable to recover from a corrupt local
// store, which is the situation the request implies.
func TestPullSinceTreatsAGarbageCursorAsFullResync(t *testing.T) {
	server, token, _ := syncSetup(t)

	for _, cursor := range []string{"abc", "-1", "999999999999999999999"} {
		status, body := request(t, server, http.MethodGet, "/sync/pull?since="+cursor, token, nil)
		if status != http.StatusOK {
			t.Fatalf("since=%s returned %d: %v", cursor, status, body)
		}
		changes := body["changes"].(map[string]any)
		if len(changes["units"].([]any)) == 0 {
			t.Errorf("since=%s should return everything, got no units", cursor)
		}
	}
}

// TestSyncCannotReachAnotherTenant is the isolation check for the sync path. The tenant
// comes from the session, never the payload, so a client cannot sync into another account.
func TestSyncCannotReachAnotherTenant(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	tokenA, _ := login(t, server, bootstrap(t, server))
	placeA := createPlaceForTest(t, server, tokenA, "Дом A")
	unitA := createUnitForTest(t, server, tokenA, placeA, "Коттедж A")

	secondToken := bootstrapSecondAccount(t, server, database, uniqueEmail(t))

	t.Run("pull returns nothing for the other tenant", func(t *testing.T) {
		status, body := pull(t, server, secondToken, -1)
		if status != http.StatusOK {
			t.Fatalf("pull returned %d: %v", status, body)
		}
		changes := body["changes"].(map[string]any)
		if len(changes["places"].([]any)) != 0 || len(changes["units"].([]any)) != 0 {
			t.Errorf("tenant B sees tenant A's data: places=%d units=%d",
				len(changes["places"].([]any)), len(changes["units"].([]any)))
		}
	})

	t.Run("push cannot overwrite another tenant's row", func(t *testing.T) {
		// Tenant B pushes tenant A's unit id with a new name. Whether the server refuses
		// outright or reports the row as unusable does not matter; what matters is that
		// tenant A's data is untouched.
		//
		// Two independent layers stop this, which is why the exact error varies: the sync
		// update is scoped by tenant_id so it matches no row for B, and the subsequent
		// insert then collides with the per-tenant unique name index. Either way the write
		// cannot land, so the assertion is on the outcome rather than the status code.
		status, body := push(t, server, secondToken, "device-b", map[string]any{
			"units": []any{map[string]any{"id": unitA, "name": "Захвачено", "capacity": 99}},
		})
		if status == http.StatusOK {
			results, _ := body["results"].([]any)
			if len(results) > 0 && results[0].(map[string]any)["outcome"] == "applied" {
				t.Errorf("a cross-tenant push reported success: %v", results[0])
			}
		}

		// Tenant A's row is unchanged. This is the assertion that matters.
		status, detail := getJSON(t, server, "/units/"+unitA, tokenA)
		if status != http.StatusOK {
			t.Fatalf("tenant A's unit is gone: %d %v", status, detail)
		}
		unit := detail["unit"].(map[string]any)
		if unit["name"] != "Коттедж A" || unit["capacity"] != float64(4) {
			t.Errorf("tenant A's unit was modified: %v", unit)
		}

		// And tenant B still has no units of its own.
		status, own := pull(t, server, secondToken, -1)
		if status != http.StatusOK {
			t.Fatalf("pull returned %d: %v", status, own)
		}
		changes := own["changes"].(map[string]any)
		if len(changes["units"].([]any)) != 0 {
			t.Errorf("tenant B should not see %d units", len(changes["units"].([]any)))
		}
	})
}

package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/inajaf/dombook/server/internal/auth"
	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/domainservice"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/inajaf/dombook/server/internal/testdb"
)

// These tests drive the domain CRUD over real HTTP against real PostgreSQL. They cover
// the WIRING rather than the rules: whether the route exists under the right method,
// whether the guard actually runs, and whether the wire shape matches what a client
// sends. The rules themselves are tested in internal/domain and internal/store.

// pinnedToday fixes the calendar date the domain tests work in.
//
// A booking-window rule is expressed in days relative to "today", so a test using the real
// clock would produce different dates depending on when it ran. The clock is pinned at an
// instant that is midday in the account's timezone, which keeps the resolved date stable
// regardless of the host's zone: an instant near midnight would fall on a different day in
// UTC+4 than in UTC, and the assertion would pass or fail by geography.
var (
	pinnedToday = domain.MustParseDate("2026-08-11")
	pinnedNow   = time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC).Add(4 * time.Hour)
)

// datesFrom returns the pinned date shifted by the given number of days.
func datesFrom(offsetDays int) string { return pinnedToday.AddDays(offsetDays).String() }

// newDomainServer builds the full stack — routes, middleware, auth and domain services —
// against the shared test database, and returns it with a logged-in owner's token.
func newDomainServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	testdb.Prepare(t)
	// Each test starts from an empty installation, because the bootstrap gate closes as
	// soon as any user exists.
	testdb.ResetData(t)

	database, err := store.New(context.Background(), testdb.AppDSN(t))
	if err != nil {
		t.Fatalf("connect as dombook_app: %v", err)
	}
	t.Cleanup(database.Close)

	authService := auth.New(database, auth.Options{
		AppName:    "RentKeeper Test",
		JWTSecret:  testJWTSecret,
		AccessTTL:  time.Hour,
		RefreshTTL: 24 * time.Hour,
		OTPTTL:     10 * time.Minute,
		OTPLength:  6,
		ExposeCode: true,
	}, newTestLimiter(), nil)

	domainService := domainservice.New(database, domainservice.Options{
		// One clock for the validator and the policy view, so the day a booking is judged
		// against is the same day the client is told.
		Now: func() time.Time { return pinnedNow },
	})

	handler, err := BuildHandler(
		Deps{Auth: authService, Domain: domainService, Store: database},
		CORSConfig{AllowedOrigins: []string{"*"}},
	)
	if err != nil {
		t.Fatalf("build handler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	token, _ := login(t, server, bootstrap(t, server))
	return server, token
}

// getJSON performs an authenticated GET and decodes the response.
func getJSON(t *testing.T, server *httptest.Server, path, token string) (int, map[string]any) {
	t.Helper()
	return request(t, server, http.MethodGet, path, token, nil)
}

// createPlaceForTest posts a place and returns its id.
func createPlaceForTest(t *testing.T, server *httptest.Server, token, name string) string {
	t.Helper()
	status, body := request(t, server, http.MethodPost, "/places", token, map[string]any{
		"name": name, "address": "Габала", "hasFoodService": true,
		"breakfastPriceMinor": 1500,
		"lunchPriceMinor":     2500,
		"dinnerPriceMinor":    3000,
	})
	if status != http.StatusCreated {
		t.Fatalf("POST /places returned %d: %v", status, body)
	}
	place, ok := body["place"].(map[string]any)
	if !ok {
		t.Fatalf("response has no place object: %v", body)
	}
	id, _ := place["id"].(string)
	if id == "" {
		t.Fatalf("place has no id: %v", place)
	}
	return id
}

// createUnitForTest posts a unit and returns its id.
func createUnitForTest(t *testing.T, server *httptest.Server, token, placeID, name string) string {
	t.Helper()
	payload := map[string]any{
		"name": name, "kind": "cottage", "capacity": 4,
		"basePriceMinor": 24000, "depositMinor": 30000, "currency": "AZN",
	}
	if placeID != "" {
		payload["placeId"] = placeID
	}
	status, body := request(t, server, http.MethodPost, "/units", token, payload)
	if status != http.StatusCreated {
		t.Fatalf("POST /units returned %d: %v", status, body)
	}
	unit, ok := body["unit"].(map[string]any)
	if !ok {
		t.Fatalf("response has no unit object: %v", body)
	}
	id, _ := unit["id"].(string)
	if id == "" {
		t.Fatalf("unit has no id: %v", unit)
	}
	return id
}

// createReservation posts a booking and returns the reservation object.
func createReservation(t *testing.T, server *httptest.Server, token, unitID, checkIn, checkOut string) map[string]any {
	t.Helper()
	status, body := request(t, server, http.MethodPost, "/reservations", token, map[string]any{
		"unitId": unitID, "guestName": "Иван Петров", "guestPhone": "+994 50 123 45 67",
		"checkInDate": checkIn, "checkOutDate": checkOut,
		"adults": 2, "children": 1,
		"depositMinor": 30000, "depositStatus": "due",
	})
	if status != http.StatusCreated {
		t.Fatalf("POST /reservations returned %d: %v", status, body)
	}
	reservation, ok := body["reservation"].(map[string]any)
	if !ok {
		t.Fatalf("response has no reservation object: %v", body)
	}
	return reservation
}

func TestPlaceEndpoints(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Лесная долина")

	t.Run("list returns the created place", func(t *testing.T) {
		status, body := getJSON(t, server, "/places", token)
		if status != http.StatusOK {
			t.Fatalf("GET /places returned %d: %v", status, body)
		}
		places, ok := body["places"].([]any)
		if !ok {
			t.Fatalf("response has no places array: %v", body)
		}
		if len(places) != 1 {
			t.Fatalf("got %d places, want 1", len(places))
		}
		place := places[0].(map[string]any)
		// Camel-case fields are what the existing clients send and expect.
		if place["hasFoodService"] != true {
			t.Errorf("hasFoodService = %v", place["hasFoodService"])
		}
		if place["breakfastPriceMinor"] != float64(1500) {
			t.Errorf("breakfastPriceMinor = %v", place["breakfastPriceMinor"])
		}
		// Internal columns must not leak into the wire format.
		for _, forbidden := range []string{"tenant_id", "deleted_at", "last_writer"} {
			if _, present := place[forbidden]; present {
				t.Errorf("place view leaks the internal field %q", forbidden)
			}
		}
	})

	t.Run("get by id", func(t *testing.T) {
		status, body := getJSON(t, server, "/places/"+placeID, token)
		if status != http.StatusOK {
			t.Fatalf("GET /places/{id} returned %d: %v", status, body)
		}
		if body["place"].(map[string]any)["id"] != placeID {
			t.Errorf("id = %v, want %s", body["place"].(map[string]any)["id"], placeID)
		}
	})

	t.Run("update", func(t *testing.T) {
		status, body := request(t, server, http.MethodPut, "/places/"+placeID, token, map[string]any{
			"name": "Переименованный", "address": "Шеки", "hasFoodService": false,
		})
		if status != http.StatusOK {
			t.Fatalf("PUT returned %d: %v", status, body)
		}
		place := body["place"].(map[string]any)
		if place["name"] != "Переименованный" {
			t.Errorf("name = %v", place["name"])
		}
		// Disabling food service zeroes the prices, so the place cannot advertise meals.
		if place["breakfastPriceMinor"] != float64(0) {
			t.Errorf("breakfastPriceMinor = %v, want 0", place["breakfastPriceMinor"])
		}
	})

	t.Run("archive and restore", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/places/"+placeID+"/archive", token, nil)
		if status != http.StatusOK {
			t.Fatalf("archive returned %d: %v", status, body)
		}
		if body["place"].(map[string]any)["status"] != "archived" {
			t.Errorf("status = %v, want archived", body["place"].(map[string]any)["status"])
		}
		if status, _ := request(t, server, http.MethodPost, "/places/"+placeID+"/restore", token, nil); status != http.StatusOK {
			t.Errorf("restore returned %d", status)
		}
	})

	t.Run("delete", func(t *testing.T) {
		if status, body := request(t, server, http.MethodDelete, "/places/"+placeID, token, nil); status != http.StatusOK {
			t.Fatalf("DELETE returned %d: %v", status, body)
		}
		if status, _ := getJSON(t, server, "/places/"+placeID, token); status != http.StatusNotFound {
			t.Errorf("a deleted place should 404, got %d", status)
		}
	})
}

func TestPlaceValidationErrorsCarryTheFieldName(t *testing.T) {
	server, token := newDomainServer(t)

	status, body := request(t, server, http.MethodPost, "/places", token, map[string]any{"address": "без имени"})
	if status != http.StatusBadRequest {
		t.Fatalf("returned %d, want 400: %v", status, body)
	}
	errorObject := body["error"].(map[string]any)
	if errorObject["code"] != "required" {
		t.Errorf("code = %v, want required", errorObject["code"])
	}
	// The field name is what lets a form highlight the offending input.
	details, ok := errorObject["details"].(map[string]any)
	if !ok || details["field"] != "name" {
		t.Errorf("details = %v, want field=name", errorObject["details"])
	}
}

func TestUnitEndpoints(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Дом отдыха")
	unitID := createUnitForTest(t, server, token, placeID, "Коттедж «Сосны»")

	t.Run("list and filter by place", func(t *testing.T) {
		status, body := getJSON(t, server, "/units?placeId="+placeID, token)
		if status != http.StatusOK {
			t.Fatalf("GET /units returned %d: %v", status, body)
		}
		units, _ := body["units"].([]any)
		if len(units) != 1 {
			t.Fatalf("got %d units, want 1", len(units))
		}
		unit := units[0].(map[string]any)
		if unit["capacity"] != float64(4) {
			t.Errorf("capacity = %v", unit["capacity"])
		}
		if unit["currency"] != "AZN" {
			t.Errorf("currency = %v", unit["currency"])
		}
	})

	t.Run("get by id returns the place link", func(t *testing.T) {
		status, body := getJSON(t, server, "/units/"+unitID, token)
		if status != http.StatusOK {
			t.Fatalf("GET /units/{id} returned %d: %v", status, body)
		}
		unit := body["unit"].(map[string]any)
		if unit["placeId"] != placeID {
			t.Errorf("placeId = %v, want %s", unit["placeId"], placeID)
		}
	})

	t.Run("standalone house has a null place", func(t *testing.T) {
		// The free plan allows one active unit, so archive the first to free the slot.
		if status, body := request(t, server, http.MethodPost, "/units/"+unitID+"/archive", token, nil); status != http.StatusOK {
			t.Fatalf("archive returned %d: %v", status, body)
		}
		houseID := createUnitForTest(t, server, token, "", "Отдельный дом")

		status, body := getJSON(t, server, "/units/"+houseID, token)
		if status != http.StatusOK {
			t.Fatalf("GET /units/{id} returned %d: %v", status, body)
		}
		if body["unit"].(map[string]any)["placeId"] != nil {
			t.Errorf("placeId = %v, want null for a standalone house", body["unit"].(map[string]any)["placeId"])
		}
	})

	t.Run("validation names the offending field", func(t *testing.T) {
		// The free plan's unit slot is already taken by this point, and the quota check
		// runs before field validation — so the request is rejected for the quota, not
		// the missing capacity. Archive the existing unit to free the slot and let the
		// validation path be the thing under test.
		status, body := getJSON(t, server, "/units", token)
		if status != http.StatusOK {
			t.Fatalf("GET /units returned %d: %v", status, body)
		}
		for _, raw := range body["units"].([]any) {
			unit := raw.(map[string]any)
			if unit["status"] != "active" {
				continue
			}
			id, _ := unit["id"].(string)
			if archived, archiveBody := request(t, server, http.MethodPost, "/units/"+id+"/archive", token, nil); archived != http.StatusOK {
				t.Fatalf("archive returned %d: %v", archived, archiveBody)
			}
		}

		status, body = request(t, server, http.MethodPost, "/units", token, map[string]any{
			"name": "Без вместимости", "basePriceMinor": 1000, "depositMinor": 0,
		})
		if status != http.StatusBadRequest {
			t.Fatalf("returned %d, want 400: %v", status, body)
		}
		details := body["error"].(map[string]any)["details"].(map[string]any)
		if details["field"] != "capacity" {
			t.Errorf("field = %v, want capacity", details["field"])
		}
	})
}

// TestFreePlanUnitLimitIsReportedAsAPlanLimit checks the wire contract for a quota
// rejection: the client needs the machine-readable cap to render an upgrade prompt
// rather than a generic error.
func TestFreePlanUnitLimitIsReportedAsAPlanLimit(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Дом отдыха")
	createUnitForTest(t, server, token, placeID, "Первый")

	status, body := request(t, server, http.MethodPost, "/units", token, map[string]any{
		"name": "Второй", "kind": "cottage", "capacity": 2,
		"basePriceMinor": 10000, "depositMinor": 0, "currency": "AZN",
		"placeId": placeID,
	})
	if status != http.StatusForbidden {
		t.Fatalf("a second active unit returned %d, want 403: %v", status, body)
	}
	errorObject := body["error"].(map[string]any)
	if errorObject["code"] != "plan_limit" {
		t.Errorf("code = %v, want plan_limit", errorObject["code"])
	}
	details := errorObject["details"].(map[string]any)
	if details["resource"] != "units" || details["limit"] != float64(1) {
		t.Errorf("details = %v, want resource=units limit=1", details)
	}
}

func TestReservationEndpoints(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Дом отдыха")
	unitID := createUnitForTest(t, server, token, placeID, "Коттедж")

	// Dates are relative to the server's pinned "today" (2026-08-11), so they always sit
	// inside the 21-day booking window.
	checkIn, checkOut := datesFrom(5), datesFrom(8)
	created := createReservation(t, server, token, unitID, checkIn, checkOut)

	t.Run("the response carries the computed totals and nights", func(t *testing.T) {
		if created["accommodationMinor"] != float64(3*24000) {
			t.Errorf("accommodationMinor = %v, want %d", created["accommodationMinor"], 3*24000)
		}
		nights, ok := created["nights"].([]any)
		if !ok || len(nights) != 3 {
			t.Fatalf("nights = %v, want 3", created["nights"])
		}
		// Nights are plain calendar dates, never timestamps: a timestamp would let a
		// client in another timezone shift a night.
		first := nights[0].(map[string]any)["date"].(string)
		if len(first) != 10 {
			t.Errorf("night date %q is not a calendar date", first)
		}
	})

	t.Run("list includes the booking", func(t *testing.T) {
		status, body := getJSON(t, server, "/reservations", token)
		if status != http.StatusOK {
			t.Fatalf("GET /reservations returned %d: %v", status, body)
		}
		if len(body["reservations"].([]any)) != 1 {
			t.Errorf("got %d reservations, want 1", len(body["reservations"].([]any)))
		}
	})

	t.Run("an overlapping booking is a conflict", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/reservations", token, map[string]any{
			"unitId": unitID, "guestName": "Другой гость",
			"checkInDate": checkIn, "checkOutDate": checkOut,
			"adults": 1, "children": 0,
		})
		// 409 rather than 400: the request is well-formed, the state collides. A client
		// offers another unit rather than fixing its input.
		if status != http.StatusConflict {
			t.Fatalf("overlapping booking returned %d, want 409: %v", status, body)
		}
		errorObject := body["error"].(map[string]any)
		if errorObject["code"] != "night_conflict" {
			t.Errorf("code = %v, want night_conflict", errorObject["code"])
		}
		details, _ := errorObject["details"].(map[string]any)
		if details == nil || details["dates"] == nil {
			t.Errorf("details should name the conflicting dates: %v", errorObject["details"])
		}
	})

	t.Run("a booking beyond the window is refused", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/reservations", token, map[string]any{
			"unitId": unitID, "guestName": "Ранний гость",
			"checkInDate": datesFrom(60), "checkOutDate": datesFrom(62),
			"adults": 1, "children": 0,
		})
		if status != http.StatusBadRequest {
			t.Fatalf("a booking beyond the window returned %d, want 400: %v", status, body)
		}
		if code := body["error"].(map[string]any)["code"]; code != "check_in_too_far" {
			t.Errorf("code = %v, want check_in_too_far", code)
		}
	})

	t.Run("capacity overflow is refused", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/reservations", token, map[string]any{
			"unitId": unitID, "guestName": "Большая компания",
			"checkInDate": datesFrom(10), "checkOutDate": datesFrom(12),
			"adults": 10, "children": 0,
		})
		if status != http.StatusBadRequest {
			t.Fatalf("capacity overflow returned %d, want 400: %v", status, body)
		}
		if code := body["error"].(map[string]any)["code"]; code != "capacity_exceeded" {
			t.Errorf("code = %v, want capacity_exceeded", code)
		}
	})

	reservationID := created["id"].(string)

	t.Run("cancel frees the dates", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/reservations/"+reservationID+"/cancel", token, nil)
		if status != http.StatusOK {
			t.Fatalf("cancel returned %d: %v", status, body)
		}
		if body["reservation"].(map[string]any)["status"] != "cancelled" {
			t.Errorf("status = %v, want cancelled", body["reservation"].(map[string]any)["status"])
		}
		// Cancelling twice is a client error, not a silent success.
		if status, _ := request(t, server, http.MethodPost, "/reservations/"+reservationID+"/cancel", token, nil); status != http.StatusBadRequest {
			t.Errorf("double cancel returned %d, want 400", status)
		}
		// The dates are bookable again.
		createReservation(t, server, token, unitID, checkIn, checkOut)
	})
}

// TestDeletingAnActiveReservationIsRefused pins the rule that a live booking must be
// cancelled first, with a message that explains it.
func TestDeletingAnActiveReservationIsRefused(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Дом отдыха")
	unitID := createUnitForTest(t, server, token, placeID, "Коттедж")
	created := createReservation(t, server, token, unitID, datesFrom(5), datesFrom(7))
	reservationID := created["id"].(string)

	status, body := request(t, server, http.MethodDelete, "/reservations/"+reservationID, token, nil)
	if status != http.StatusBadRequest {
		t.Fatalf("deleting an active booking returned %d, want 400: %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "reservation_active" {
		t.Errorf("code = %v, want reservation_active", code)
	}

	if status, _ := request(t, server, http.MethodPost, "/reservations/"+reservationID+"/cancel", token, nil); status != http.StatusOK {
		t.Fatalf("cancel returned %d", status)
	}
	if status, body := request(t, server, http.MethodDelete, "/reservations/"+reservationID, token, nil); status != http.StatusOK {
		t.Fatalf("deleting a cancelled booking returned %d: %v", status, body)
	}
}

// TestDeletingAPlaceWithUnitsIsRefused prevents leaving units attached to a removed
// parent, which the owner would only discover later.
func TestDeletingAPlaceWithUnitsIsRefused(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Дом отдыха")
	createUnitForTest(t, server, token, placeID, "Коттедж")

	status, body := request(t, server, http.MethodDelete, "/places/"+placeID, token, nil)
	if status != http.StatusConflict {
		t.Fatalf("deleting a place with units returned %d, want 409: %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "place_has_units" {
		t.Errorf("code = %v, want place_has_units", code)
	}
}

// TestDomainRoutesRequireAuthentication is the guard test: every domain endpoint must be
// unreachable without a token, or tenant isolation is decorative.
func TestDomainRoutesRequireAuthentication(t *testing.T) {
	server, _ := newDomainServer(t)
	const missing = "00000000-0000-0000-0000-000000000000"

	probes := []struct{ method, path string }{
		{http.MethodGet, "/places"},
		{http.MethodPost, "/places"},
		{http.MethodGet, "/places/" + missing},
		{http.MethodPut, "/places/" + missing},
		{http.MethodDelete, "/places/" + missing},
		{http.MethodPost, "/places/" + missing + "/archive"},
		{http.MethodPost, "/places/" + missing + "/restore"},
		{http.MethodGet, "/units"},
		{http.MethodPost, "/units"},
		{http.MethodGet, "/units/" + missing},
		{http.MethodPut, "/units/" + missing},
		{http.MethodDelete, "/units/" + missing},
		{http.MethodGet, "/reservations"},
		{http.MethodPost, "/reservations"},
		{http.MethodGet, "/reservations/" + missing},
		{http.MethodPut, "/reservations/" + missing},
		{http.MethodDelete, "/reservations/" + missing},
		{http.MethodPost, "/reservations/" + missing + "/cancel"},
	}

	for _, probe := range probes {
		status, _ := request(t, server, probe.method, probe.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Errorf("%s %s without a token returned %d, want 401", probe.method, probe.path, status)
		}
	}
}

// TestDomainDataIsScopedToTheSessionTenant is the second half of isolation: an
// authenticated caller cannot reach another account's rows even knowing their ids.
func TestDomainDataIsScopedToTheSessionTenant(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	tokenA, _ := login(t, server, bootstrap(t, server))
	placeA := createPlaceForTest(t, server, tokenA, "Дом A")
	unitA := createUnitForTest(t, server, tokenA, placeA, "Коттедж A")

	// The bootstrap gate is closed now, so the second account is created through the
	// store directly: the HTTP signup path is deliberately unavailable, which is the
	// behaviour asserted by TestSetupIsOpenOnceThenGated.
	secondEmail := uniqueEmail(t)
	secondToken := bootstrapSecondAccount(t, server, database, secondEmail)

	t.Run("list is empty for the other tenant", func(t *testing.T) {
		status, body := getJSON(t, server, "/places", secondToken)
		if status != http.StatusOK {
			t.Fatalf("GET /places returned %d: %v", status, body)
		}
		if places, _ := body["places"].([]any); len(places) != 0 {
			t.Errorf("tenant B sees %d of tenant A's places", len(places))
		}
	})

	t.Run("direct id access is a 404", func(t *testing.T) {
		// Not 403: distinguishing "exists but not yours" from "does not exist" would let
		// a caller enumerate other tenants' ids.
		if status, _ := getJSON(t, server, "/places/"+placeA, secondToken); status != http.StatusNotFound {
			t.Errorf("GET another tenant's place returned %d, want 404", status)
		}
		if status, _ := getJSON(t, server, "/units/"+unitA, secondToken); status != http.StatusNotFound {
			t.Errorf("GET another tenant's unit returned %d, want 404", status)
		}
	})

	t.Run("writing to another tenant's row is a 404", func(t *testing.T) {
		status, _ := request(t, server, http.MethodPut, "/places/"+placeA, secondToken, map[string]any{"name": "Захвачено"})
		if status != http.StatusNotFound {
			t.Errorf("PUT on another tenant's place returned %d, want 404", status)
		}
		// And the original is intact.
		status, body := getJSON(t, server, "/places/"+placeA, tokenA)
		if status != http.StatusOK {
			t.Fatalf("tenant A's place is gone: %d %v", status, body)
		}
		if body["place"].(map[string]any)["name"] != "Дом A" {
			t.Errorf("tenant A's place was modified: %v", body["place"])
		}
	})
}

// TestAccountPlanEndpoint reports the plan and its usage, which the desktop sidebar
// renders and the upgrade prompt depends on.
func TestAccountPlanEndpoint(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Дом отдыха")
	createUnitForTest(t, server, token, placeID, "Коттедж")

	status, body := getJSON(t, server, "/account/plan", token)
	if status != http.StatusOK {
		t.Fatalf("GET /account/plan returned %d: %v", status, body)
	}
	if body["plan"] != "free" {
		t.Errorf("plan = %v, want free", body["plan"])
	}
	if body["today"] != pinnedToday.String() {
		t.Errorf("today = %v, want %s", body["today"], pinnedToday)
	}
	usage, ok := body["usage"].(map[string]any)
	if !ok {
		t.Fatalf("response has no usage object: %v", body)
	}
	units, ok := usage["units"].(map[string]any)
	if !ok {
		t.Fatalf("usage has no units: %v", usage)
	}
	if units["current"] != float64(1) || units["limit"] != float64(1) {
		t.Errorf("unit usage = %v, want current 1 limit 1", units)
	}
	// overLimit is what tells the client to show an upgrade prompt after a downgrade.
	if units["overLimit"] != false {
		t.Errorf("overLimit = %v, want false", units["overLimit"])
	}
}

// newDomainServerWithDatabase is newDomainServer plus the database handle, for tests
// that must seed a second account directly (the HTTP signup path is closed once a user
// exists, which is separate behaviour under test).
func newDomainServerWithDatabase(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	testdb.Prepare(t)
	testdb.ResetData(t)

	database, err := store.New(context.Background(), testdb.AppDSN(t))
	if err != nil {
		t.Fatalf("connect as dombook_app: %v", err)
	}
	t.Cleanup(database.Close)

	domainService := domainservice.New(database, domainservice.Options{
		Now: func() time.Time { return pinnedNow },
	})
	handler, err := BuildHandler(
		Deps{Auth: authServiceForTest(t, database), Domain: domainService, Store: database},
		CORSConfig{AllowedOrigins: []string{"*"}},
	)
	if err != nil {
		t.Fatalf("build handler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, database
}

// bootstrapSecondAccount creates a second tenant directly through the store and logs in,
// returning its access token.
//
// Going through the store rather than POST /auth/setup is deliberate: that endpoint is
// closed once any user exists, and the test needs a genuine second tenant to prove
// isolation rather than to re-test the bootstrap gate.
func bootstrapSecondAccount(t *testing.T, server *httptest.Server, database *store.Store, email string) string {
	t.Helper()
	ctx := context.Background()

	if _, _, err := database.CreateAccountWithOwner(ctx, "Второй дом отдыха", email, "Второй", store.PlanFree); err != nil {
		t.Fatalf("create second account: %v", err)
	}
	token, _ := login(t, server, email)
	if token == "" {
		t.Fatal("the second account could not log in")
	}
	return token
}

// addMemberAndLogin creates a staff member in the owner's account and logs in as them.
//
// Created through the store rather than the invite flow: invitations have their own tests,
// and this only needs a second identity inside the SAME account to check role enforcement.
func addMemberAndLogin(t *testing.T, server *httptest.Server, database *store.Store, ownerToken string) string {
	t.Helper()
	ctx := context.Background()

	_, me := getJSON(t, server, "/auth/me", ownerToken)
	accountID, _ := me["accountId"].(string)
	if accountID == "" {
		t.Fatal("could not determine the account id")
	}

	staffEmail := uniqueEmail(t)
	userID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	if _, err := database.AddUserToAccount(ctx, userID, accountID, staffEmail, "Staff", store.RoleStaff); err != nil {
		t.Fatalf("AddUserToAccount: %v", err)
	}

	token, _ := login(t, server, staffEmail)
	if token == "" {
		t.Fatal("the staff member could not log in")
	}
	return token
}

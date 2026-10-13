package api

import (
	"net/http"
	"testing"
	"time"
)

// Booking-policy endpoint tests.
//
// The policy governs what every member of an account may book, so these cover three things
// that matter beyond the happy path: the client is told which calendar day "today" is in
// the ACCOUNT's timezone, only an owner may change the window, and the bounds are enforced
// rather than merely documented.

func TestBookingPolicyIsReadableAndReportsToday(t *testing.T) {
	server, token := newDomainServer(t)

	status, body := getJSON(t, server, "/account/booking-policy", token)
	if status != http.StatusOK {
		t.Fatalf("GET /account/booking-policy returned %d: %v", status, body)
	}

	// The shipped defaults, so an account that has never configured anything still books.
	if body["maximumAdvanceDays"] != float64(21) {
		t.Errorf("maximumAdvanceDays = %v, want 21", body["maximumAdvanceDays"])
	}
	if body["maximumStayMonths"] != float64(3) {
		t.Errorf("maximumStayMonths = %v, want 3", body["maximumStayMonths"])
	}
	if body["timeZone"] != "Asia/Baku" {
		t.Errorf("timeZone = %v, want Asia/Baku", body["timeZone"])
	}
	// `today` is resolved by the server in the ACCOUNT's timezone, so a client cannot
	// disagree with it about which dates are bookable by using its own clock. The value is
	// a calendar date: a timestamp here would let a client in another zone shift it.
	today, _ := body["today"].(string)
	if today != pinnedToday.String() {
		t.Errorf("today = %v, want the pinned %s", body["today"], pinnedToday)
	}
	// The last bookable check-in is derived from that today plus the window, so the client
	// can render the picker's upper bound without recomputing the rule.
	wantCheckIn := addDaysTo(t, today, 21)
	if body["maximumCheckInDate"] != wantCheckIn {
		t.Errorf("maximumCheckInDate = %v, want %s (today %s + 21 days)", body["maximumCheckInDate"], wantCheckIn, today)
	}
	if body["isDefault"] != true {
		t.Errorf("isDefault = %v, want true for an unconfigured account", body["isDefault"])
	}
}

// addDaysTo shifts a YYYY-MM-DD date, so a test can derive an expected bound from whatever
// today the server reported instead of hard-coding one.
func addDaysTo(t *testing.T, date string, days int) string {
	t.Helper()
	parsed, err := time.Parse("2006-01-02", date)
	if err != nil {
		t.Fatalf("server returned a non-date today %q: %v", date, err)
	}
	return parsed.AddDate(0, 0, days).Format("2006-01-02")
}

func TestOwnerCanWidenTheBookingPolicy(t *testing.T) {
	server, token := newDomainServer(t)

	status, body := request(t, server, http.MethodPatch, "/account/booking-policy", token, map[string]any{
		"maximumAdvanceDays": 60,
		"maximumStayMonths":  6,
	})
	if status != http.StatusOK {
		t.Fatalf("PATCH returned %d: %v", status, body)
	}
	if body["maximumAdvanceDays"] != float64(60) || body["maximumStayMonths"] != float64(6) {
		t.Errorf("policy was not updated: %v", body)
	}
	if body["isDefault"] != false {
		t.Error("a configured account should not report the default policy")
	}
	// The derived bound moves with the window.
	today, _ := body["today"].(string)
	if body["maximumCheckInDate"] != addDaysTo(t, today, 60) {
		t.Errorf("maximumCheckInDate = %v, want %s (today + 60)", body["maximumCheckInDate"], addDaysTo(t, today, 60))
	}
}

// TestWidenedPolicyAllowsALongerHorizon is the end-to-end version of the same claim: after
// the change, a booking that the default window refuses must succeed. Asserting only on the
// response body would leave it open whether the validator reads the stored policy at all.
func TestWidenedPolicyAllowsALongerHorizon(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Политика")
	unitID := createUnitForTest(t, server, token, placeID, "Коттедж")

	// 40 days out is beyond the default 21-day window.
	far := datesFrom(40)
	farOut := datesFrom(43)

	status, body := request(t, server, http.MethodPost, "/reservations", token, map[string]any{
		"unitId": unitID, "guestName": "Гость", "checkInDate": far, "checkOutDate": farOut,
		"adults": 1, "children": 0,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("a booking beyond the default window returned %d, want 400: %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "check_in_too_far" {
		t.Fatalf("code = %v, want check_in_too_far", code)
	}

	// Widen the window.
	if status, body := request(t, server, http.MethodPatch, "/account/booking-policy", token, map[string]any{
		"maximumAdvanceDays": 60,
	}); status != http.StatusOK {
		t.Fatalf("PATCH returned %d: %v", status, body)
	}

	// The same booking now succeeds, which is what proves the validator reads the stored
	// policy rather than the compiled default.
	status, body = request(t, server, http.MethodPost, "/reservations", token, map[string]any{
		"unitId": unitID, "guestName": "Гость", "checkInDate": far, "checkOutDate": farOut,
		"adults": 1, "children": 0,
	})
	if status != http.StatusCreated {
		t.Fatalf("after widening, the booking returned %d, want 201: %v", status, body)
	}
}

// TestNarrowedPolicyRefusesPreviouslyValidDates is the other direction: an owner who
// tightens the window must actually stop bookings outside it.
func TestNarrowedPolicyRefusesPreviouslyValidDates(t *testing.T) {
	server, token := newDomainServer(t)
	placeID := createPlaceForTest(t, server, token, "Политика")
	unitID := createUnitForTest(t, server, token, placeID, "Коттедж")

	if status, body := request(t, server, http.MethodPatch, "/account/booking-policy", token, map[string]any{
		"maximumAdvanceDays": 7,
	}); status != http.StatusOK {
		t.Fatalf("PATCH returned %d: %v", status, body)
	}

	// Ten days out is inside the default window but beyond the new one.
	status, body := request(t, server, http.MethodPost, "/reservations", token, map[string]any{
		"unitId": unitID, "guestName": "Гость",
		"checkInDate": datesFrom(10), "checkOutDate": datesFrom(12),
		"adults": 1, "children": 0,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("a booking beyond the narrowed window returned %d, want 400: %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "check_in_too_far" {
		t.Errorf("code = %v, want check_in_too_far", code)
	}
}

// TestPolicyRejectsNonsensicalAndUnboundedValues covers the bounds. Without an upper limit
// an owner could "configure" a million-day horizon, which is not a policy but a way to
// disable validation while appearing to keep it.
func TestPolicyRejectsNonsensicalAndUnboundedValues(t *testing.T) {
	server, token := newDomainServer(t)

	cases := []struct {
		name   string
		body   map[string]any
		reason string
	}{
		{"zero advance days", map[string]any{"maximumAdvanceDays": 0}, "a zero window would forbid every booking"},
		{"negative advance days", map[string]any{"maximumAdvanceDays": -5}, "negative is not a window"},
		{"zero stay months", map[string]any{"maximumStayMonths": 0}, "zero length would forbid every stay"},
		{"absurd advance window", map[string]any{"maximumAdvanceDays": 100000}, "an unbounded horizon disables the rule"},
		{"absurd stay length", map[string]any{"maximumStayMonths": 1000}, "an unbounded length disables the rule"},
		{"unknown timezone", map[string]any{"timeZone": "Mars/Olympus"}, "a bad zone cannot resolve today"},
		{"empty timezone", map[string]any{"timeZone": ""}, "an empty zone cannot resolve today"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, body := request(t, server, http.MethodPatch, "/account/booking-policy", token, testCase.body)
			if status != http.StatusBadRequest {
				t.Fatalf("returned %d, want 400 (%s): %v", status, testCase.reason, body)
			}
		})
	}

	// And a rejection leaves the stored policy untouched, so a failed edit cannot
	// half-apply.
	status, body := getJSON(t, server, "/account/booking-policy", token)
	if status != http.StatusOK {
		t.Fatalf("GET returned %d: %v", status, body)
	}
	if body["maximumAdvanceDays"] != float64(21) || body["timeZone"] != "Asia/Baku" {
		t.Errorf("a rejected update changed the policy: %v", body)
	}
}

// TestPolicyRejectsAPartialUpdateThatBreaksTheCombination guards the validation of the
// ASSEMBLED policy: a request that only changes the timezone still has to yield a usable
// combination.
func TestPolicyRejectsAPartialUpdateThatBreaksTheCombination(t *testing.T) {
	server, token := newDomainServer(t)

	// Valid first.
	if status, body := request(t, server, http.MethodPatch, "/account/booking-policy", token, map[string]any{
		"maximumAdvanceDays": 30,
		"timeZone":           "UTC",
	}); status != http.StatusOK {
		t.Fatalf("a valid update returned %d: %v", status, body)
	}

	// Now break only the timezone. The other fields are absent, so the stored ones are
	// kept — and the resulting combination must still be refused.
	status, body := request(t, server, http.MethodPatch, "/account/booking-policy", token, map[string]any{
		"timeZone": "Not/AZone",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("returned %d, want 400: %v", status, body)
	}

	// The earlier valid values survive.
	_, current := getJSON(t, server, "/account/booking-policy", token)
	if current["maximumAdvanceDays"] != float64(30) || current["timeZone"] != "UTC" {
		t.Errorf("the rejected update disturbed the stored policy: %v", current)
	}
}

// TestOnlyAnOwnerMayChangeThePolicy: the window governs what every member may book, so a
// member editing it would be changing an account-level rule.
func TestOnlyAnOwnerMayChangeThePolicy(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	ownerToken, _ := login(t, server, bootstrap(t, server))

	// A member of the same account, created through the store since invitations are a
	// separate flow.
	staffToken := addMemberAndLogin(t, server, database, ownerToken)

	t.Run("a member can read the policy", func(t *testing.T) {
		// Reading is needed to render the date picker, so it must stay available.
		status, body := getJSON(t, server, "/account/booking-policy", staffToken)
		if status != http.StatusOK {
			t.Fatalf("a member reading the policy returned %d: %v", status, body)
		}
	})

	t.Run("a member cannot change it", func(t *testing.T) {
		status, body := request(t, server, http.MethodPatch, "/account/booking-policy", staffToken, map[string]any{
			"maximumAdvanceDays": 90,
		})
		if status != http.StatusForbidden {
			t.Fatalf("a member changing the policy returned %d, want 403: %v", status, body)
		}
		if code := body["error"].(map[string]any)["code"]; code != "forbidden" {
			t.Errorf("code = %v, want forbidden", code)
		}
	})

	t.Run("the policy is unchanged", func(t *testing.T) {
		_, body := getJSON(t, server, "/account/booking-policy", ownerToken)
		if body["maximumAdvanceDays"] != float64(21) {
			t.Errorf("the window changed despite the rejection: %v", body)
		}
	})
}

func TestBookingPolicyRequiresAuthentication(t *testing.T) {
	server, _ := newDomainServer(t)

	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/account/booking-policy"},
		{http.MethodPatch, "/account/booking-policy"},
	} {
		status, _ := request(t, server, probe.method, probe.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Errorf("%s %s without a token returned %d, want 401", probe.method, probe.path, status)
		}
	}
}

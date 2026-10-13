package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/store"
)

// Entitlement endpoint tests.
//
// The unit tests in internal/billing cover the rules in isolation. These cover the part
// those cannot: that a granted licence actually lifts the cap in the running system, on both
// the friendly check and the database trigger.

func TestEntitlementsReportTheFreeTierByDefault(t *testing.T) {
	server, token := newDomainServer(t)

	status, body := getJSON(t, server, "/account/entitlements", token)
	if status != http.StatusOK {
		t.Fatalf("GET /account/entitlements returned %d: %v", status, body)
	}
	if body["paid"] != false {
		t.Errorf("paid = %v, want false for a new account", body["paid"])
	}
	if body["planName"] != "Бесплатный" {
		t.Errorf("planName = %v, want Бесплатный", body["planName"])
	}
	// The free cap is reported as a number, so the client can render a progress bar.
	if body["unitLimit"] != float64(1) {
		t.Errorf("unitLimit = %v, want 1", body["unitLimit"])
	}
	// A perpetual licence has no expiry, so a free account has none either. Reporting a
	// date would imply the free tier lapses.
	if body["expiresAt"] != nil {
		t.Errorf("expiresAt = %v, want null", body["expiresAt"])
	}
	if body["renewalOffered"] != false {
		t.Error("renewalOffered should be false when nothing expires")
	}
	if len(body["features"].([]any)) != 0 {
		t.Errorf("features = %v, want none for the free tier", body["features"])
	}
}

// TestLicenceLiftsTheUnitCap is the end-to-end claim: the free tier refuses a second unit,
// and a granted licence lets it through.
func TestLicenceLiftsTheUnitCap(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	token := bootstrapAndLogin(t, server)
	placeID := createPlaceForTest(t, server, token, "Лицензия")

	// One unit is allowed on the free tier.
	createUnitForTest(t, server, token, placeID, "Первый")

	t.Run("a second unit is refused without a licence", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/units", token, map[string]any{
			"placeId": placeID, "name": "Второй", "capacity": 4, "basePriceMinor": 20000,
			"depositMinor": 0,
		})
		if status != http.StatusPaymentRequired && status != http.StatusForbidden {
			t.Fatalf("a second unit returned %d, want a plan limit: %v", status, body)
		}
	})

	t.Run("the entitlement view reports the free cap", func(t *testing.T) {
		_, body := getJSON(t, server, "/account/entitlements", token)
		if body["paid"] != false || body["unitLimit"] != float64(1) {
			t.Errorf("entitlements = %v, want the free tier", body)
		}
	})

	// Grant the one-time purchase.
	accountID := accountIDFor(t, server, token)
	if _, err := database.GrantEntitlement(context.Background(), accountID,
		"app_perpetual", "one_time", "order-123", nil, nil); err != nil {
		t.Fatalf("GrantEntitlement: %v", err)
	}

	t.Run("the entitlement view reports the licence", func(t *testing.T) {
		status, body := getJSON(t, server, "/account/entitlements", token)
		if status != http.StatusOK {
			t.Fatalf("GET returned %d: %v", status, body)
		}
		if body["paid"] != true {
			t.Errorf("paid = %v, want true after the grant", body["paid"])
		}
		// Unlimited is reported as null rather than a large number, so the client renders no
		// progress bar instead of one that is nearly empty forever.
		if body["unitLimit"] != nil {
			t.Errorf("unitLimit = %v, want null for an unlimited licence", body["unitLimit"])
		}
		if body["expiresAt"] != nil {
			t.Errorf("expiresAt = %v, want null for a perpetual licence", body["expiresAt"])
		}
		features, _ := body["features"].([]any)
		found := false
		for _, feature := range features {
			if feature == "paid_tier" {
				found = true
			}
		}
		if !found {
			t.Errorf("features = %v, want paid_tier", features)
		}
		// A perpetual licence need not be renewed.
		if body["renewalOffered"] != false {
			t.Error("renewalOffered should be false for a perpetual licence")
		}
	})

	t.Run("the second unit is now accepted", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/units", token, map[string]any{
			"placeId": placeID, "name": "Второй", "capacity": 4, "basePriceMinor": 20000,
			"depositMinor": 0,
		})
		if status != http.StatusCreated {
			t.Fatalf("after the licence, a second unit returned %d, want 201: %v", status, body)
		}
	})

	t.Run("the plan view agrees with the entitlement", func(t *testing.T) {
		// The plan endpoint and the quota check must not disagree: reporting the free cap
		// while permitting unlimited units would nag a paying customer to upgrade.
		_, body := getJSON(t, server, "/account/plan", token)
		if body["plan"] != "paid" {
			t.Errorf("plan = %v, want paid", body["plan"])
		}
		usage := body["usage"].(map[string]any)["units"].(map[string]any)
		if usage["limit"] != float64(0) {
			t.Errorf("units.limit = %v, want 0 (the unlimited sentinel)", usage["limit"])
		}
	})
}

// TestDatabaseTriggerFollowsTheLicence checks the race-safety backstop agrees with the
// friendly check. They read the same source now; before this change the trigger read the
// legacy plan column, so a licensed account was refused by the database while the service
// was happy to let it through.
func TestDatabaseTriggerFollowsTheLicence(t *testing.T) {
	_, database := newDomainServerWithDatabase(t)
	ctx := context.Background()

	account, place := newTenantAndPlace(t, database, "Trigger pays")

	// The trigger fires on the insert itself, so this exercises it directly rather than
	// through the service's pre-check.
	newUnit := func(name string) error {
		status := "active"
		_, err := database.CreateUnit(ctx, account.ID, &domain.UnitInput{
			PlaceID: &place, Kind: "cottage", Name: name, Capacity: 4,
			BasePriceMinor: 20000, Currency: "AZN", Status: status,
			CheckInTime: "15:00", CheckOutTime: "11:00",
		}, "test")
		return err
	}

	if err := newUnit("Первый"); err != nil {
		t.Fatalf("the first unit should be allowed: %v", err)
	}
	// No licence: the second activation must be refused by the database.
	if err := newUnit("Второй"); err == nil {
		t.Fatal("the trigger allowed a second unit without a licence")
	}

	grantLicence(t, database, account.ID)

	// With the licence, the same insert now succeeds — which is what proves the trigger
	// reads the entitlement rather than the plan column.
	if err := newUnit("Второй"); err != nil {
		t.Fatalf("the trigger refused a second unit despite the licence: %v", err)
	}
}

// TestRevokedLicenceRestoresTheCap: a refund has to actually take the feature away, or the
// revocation is only a note in a table.
func TestRevokedLicenceRestoresTheCap(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	token := bootstrapAndLogin(t, server)
	ctx := context.Background()
	accountID := accountIDFor(t, server, token)

	if _, err := database.GrantEntitlement(ctx, accountID,
		"app_perpetual", "one_time", "order-refund", nil, nil); err != nil {
		t.Fatalf("GrantEntitlement: %v", err)
	}

	_, before := getJSON(t, server, "/account/entitlements", token)
	if before["paid"] != true {
		t.Fatalf("the licence was not granted: %v", before)
	}

	affected, err := database.RevokeEntitlement(ctx, accountID, "app_perpetual", "refund")
	if err != nil {
		t.Fatalf("RevokeEntitlement: %v", err)
	}
	if affected != 1 {
		t.Errorf("revoked %d grants, want 1", affected)
	}

	_, after := getJSON(t, server, "/account/entitlements", token)
	if after["paid"] != false {
		t.Errorf("paid = %v after the refund, want false", after["paid"])
	}
	if after["unitLimit"] != float64(1) {
		t.Errorf("unitLimit = %v after the refund, want the free cap", after["unitLimit"])
	}
}

// TestEntitlementsAreIdempotentPerPurchaseReference covers webhook retries. A payment
// provider retries on any non-2xx, so a repeated delivery must not record a second grant for
// one purchase — otherwise a single sale would look like two, and a refund of one would
// leave the customer licensed.
func TestEntitlementsAreIdempotentPerPurchaseReference(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	token := bootstrapAndLogin(t, server)
	ctx := context.Background()
	accountID := accountIDFor(t, server, token)

	first, err := database.GrantEntitlement(ctx, accountID, "app_perpetual", "one_time", "txn-999", nil, nil)
	if err != nil {
		t.Fatalf("first grant: %v", err)
	}
	// The same webhook arrives again.
	second, err := database.GrantEntitlement(ctx, accountID, "app_perpetual", "one_time", "txn-999", nil, nil)
	if err != nil {
		t.Fatalf("repeated grant: %v", err)
	}
	if first != second {
		t.Errorf("a repeated delivery created a second entitlement (%s vs %s)", first, second)
	}

	history, err := database.EntitlementHistory(ctx, accountID, 50)
	if err != nil {
		t.Fatalf("EntitlementHistory: %v", err)
	}
	if len(history) != 1 {
		t.Errorf("recorded %d grants for one purchase, want 1", len(history))
	}
}

// TestRevokingWithNothingToRevokeReportsZero, so a caller can say "nothing to revoke"
// instead of appearing to succeed.
func TestRevokingWithNothingToRevokeReportsZero(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	token := bootstrapAndLogin(t, server)
	ctx := context.Background()
	accountID := accountIDFor(t, server, token)

	affected, err := database.RevokeEntitlement(ctx, accountID, "app_perpetual", "mistake")
	if err != nil {
		t.Fatalf("RevokeEntitlement: %v", err)
	}
	if affected != 0 {
		t.Errorf("revoked %d grants, want 0 when there was none", affected)
	}
}

// TestEntitlementsAreTenantScoped: a licence is evidence of a payment, so one account must
// not be able to read another's.
func TestEntitlementsAreTenantScoped(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	tokenA := bootstrapAndLogin(t, server)
	ctx := context.Background()

	accountA := accountIDFor(t, server, tokenA)
	if _, err := database.GrantEntitlement(ctx, accountA, "app_perpetual", "one_time", "order-a", nil, nil); err != nil {
		t.Fatalf("GrantEntitlement: %v", err)
	}

	// A second account must see nothing.
	accountB, _ := newTenantAndPlace(t, database, "No licence B")

	grants, err := database.ActiveEntitlements(ctx, accountB.ID)
	if err != nil {
		t.Fatalf("ActiveEntitlements: %v", err)
	}
	if len(grants) != 0 {
		t.Errorf("account B sees %d entitlements belonging to nobody", len(grants))
	}
}

func TestEntitlementsRequireAuthentication(t *testing.T) {
	server, _ := newDomainServer(t)
	status, _ := request(t, server, http.MethodGet, "/account/entitlements", "", nil)
	if status != http.StatusUnauthorized {
		t.Errorf("without a token returned %d, want 401", status)
	}
}

// bootstrapAndLogin creates the first owner account and returns a usable access token.
func bootstrapAndLogin(t *testing.T, server *httptest.Server) string {
	t.Helper()
	token, _ := login(t, server, bootstrap(t, server))
	if token == "" {
		t.Fatal("could not sign in")
	}
	return token
}

// accountIDFor reads the signed-in account's id.
func accountIDFor(t *testing.T, server *httptest.Server, token string) string {
	t.Helper()
	_, me := getJSON(t, server, "/auth/me", token)
	accountID, _ := me["accountId"].(string)
	if accountID == "" {
		t.Fatal("could not determine the account id")
	}
	return accountID
}

// newTenantAndPlace creates an account with one place, without going through the HTTP layer.
//
// Used by the tests that exercise the database trigger directly: the service's pre-check
// would refuse the very insert they want to attempt.
func newTenantAndPlace(t *testing.T, database *store.Store, name string) (*store.Account, string) {
	t.Helper()
	ctx := context.Background()

	accountID, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	account, _, err := database.CreateAccountWithOwner(ctx, name, "license-"+accountID+"@example.test", "Owner", store.PlanFree)
	if err != nil {
		t.Fatalf("CreateAccountWithOwner: %v", err)
	}

	place, err := database.CreatePlace(ctx, account.ID, &domain.PlaceInput{
		Name: "База " + name, Status: "active",
	}, "test")
	if err != nil {
		t.Fatalf("CreatePlace: %v", err)
	}
	return account, place.ID
}

// grantLicence records a one-time purchase, which is how a real customer lifts the cap.
func grantLicence(t *testing.T, database *store.Store, accountID string) {
	t.Helper()
	if _, err := database.GrantEntitlement(context.Background(), accountID,
		"app_perpetual", "manual", "test-"+accountID, nil, nil); err != nil {
		t.Fatalf("GrantEntitlement: %v", err)
	}
}

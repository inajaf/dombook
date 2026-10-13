package billing

import (
	"errors"
	"testing"
	"time"
)

// Entitlement rule tests.
//
// These are pure: the catalog and the evaluation carry the commercial rules, so they can be
// checked without a database. That matters because the rules are the part most likely to be
// changed for a pricing decision, and a change that has to be tested through SQL is a change
// nobody will test.

func at(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("bad test time %q: %v", value, err)
	}
	return parsed
}

func TestPerpetualGrantNeverExpires(t *testing.T) {
	// The one-time purchase is the product's centrepiece, so "forever" has to mean forever
	// rather than a date far enough away that nobody has checked it.
	definition, err := Lookup(SKUAppPerpetual)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if expiry := definition.ExpiryFor(at(t, "2026-01-01T00:00:00Z")); expiry != nil {
		t.Errorf("the perpetual licence expires at %v, want no expiry at all", expiry)
	}

	// And it is still active decades later.
	far := at(t, "2200-01-01T00:00:00Z")
	state := Evaluate([]Grant{{SKU: SKUAppPerpetual, GrantedAt: at(t, "2026-01-01T00:00:00Z")}}, far)
	if !state.IsPaid() {
		t.Error("the perpetual licence should still be active in 2200")
	}
	if state.ExpiresAt != nil {
		t.Errorf("ExpiresAt = %v, want nil for a perpetual licence", state.ExpiresAt)
	}
}

func TestTimeLimitedGrantExpires(t *testing.T) {
	definition, err := Lookup(SKUAppAnnual)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	granted := at(t, "2026-01-01T00:00:00Z")
	expiry := definition.ExpiryFor(granted)
	if expiry == nil {
		t.Fatal("an annual licence should have an expiry")
	}

	// Active the day before, inactive the day after. The boundary is included in the check
	// because an off-by-one here is a customer losing access a day early.
	state := Evaluate([]Grant{{SKU: SKUAppAnnual, GrantedAt: granted, ExpiresAt: expiry}}, expiry.Add(-time.Hour))
	if !state.IsPaid() {
		t.Error("the licence should be active an hour before it expires")
	}
	state = Evaluate([]Grant{{SKU: SKUAppAnnual, GrantedAt: granted, ExpiresAt: expiry}}, expiry.Add(time.Hour))
	if state.IsPaid() {
		t.Error("the licence should be inactive an hour after it expires")
	}
}

func TestExpiredLicenceFallsBackToFreeRatherThanFailing(t *testing.T) {
	// A lapsed customer is a normal customer in a normal state. Treating it as an error
	// would break the application for them instead of offering a renewal.
	state := Evaluate([]Grant{{
		SKU:       SKUAppAnnual,
		GrantedAt: at(t, "2020-01-01T00:00:00Z"),
		ExpiresAt: func() *time.Time { value := at(t, "2021-01-01T00:00:00Z"); return &value }(),
	}}, at(t, "2026-01-01T00:00:00Z"))

	if state.IsPaid() {
		t.Error("an expired licence must not grant the paid tier")
	}
	if allowance := state.UnitAllowance(); allowance != FreePlanUnitLimit {
		t.Errorf("UnitAllowance = %d, want the free limit %d", allowance, FreePlanUnitLimit)
	}
	if len(state.SKUs) != 0 {
		t.Errorf("SKUs = %v, want none for an expired grant", state.SKUs)
	}
}

func TestUnknownSKUGrantsNothing(t *testing.T) {
	// A row for a SKU this build does not know must not unlock anything. Trusting the row
	// would let a database edit or a downgrade to an older build hand out features with no
	// definition behind them.
	state := Evaluate([]Grant{{SKU: SKU("some_future_sku"), GrantedAt: at(t, "2026-01-01T00:00:00Z")}}, at(t, "2026-06-01T00:00:00Z"))
	if state.IsPaid() {
		t.Error("an unknown SKU granted the paid tier")
	}
	if _, err := Lookup(SKU("some_future_sku")); !errors.Is(err, ErrUnknownSKU) {
		t.Errorf("Lookup error = %v, want ErrUnknownSKU", err)
	}
}

func TestPaidTierIsUnlimitedRatherThanBigger(t *testing.T) {
	// A landlord with five cottages and one with fifty are both simply not capped. A finite
	// limit would eventually refuse a legitimate customer, and the number would be arbitrary.
	state := Evaluate([]Grant{{SKU: SKUAppPerpetual}}, at(t, "2026-01-01T00:00:00Z"))
	if allowance := state.UnitAllowance(); allowance != -1 {
		t.Errorf("UnitAllowance = %d, want -1 (unlimited)", allowance)
	}
	if allowed, _ := state.AllowsUnits(500); !allowed {
		t.Error("a licensed account should be allowed 500 units")
	}

	free := Evaluate(nil, at(t, "2026-01-01T00:00:00Z"))
	if allowed, limit := free.AllowsUnits(2); allowed {
		t.Errorf("the free tier allowed 2 units (limit %d)", limit)
	}
	if allowed, _ := free.AllowsUnits(1); !allowed {
		t.Error("the free tier must allow its one unit")
	}
}

func TestWhatsAppIsSeparateFromTheLicence(t *testing.T) {
	// Messaging is the one cost that scales with use, so it is sold separately. Buying the
	// app must not silently enable it, or the variable cost would be given away.
	app := Evaluate([]Grant{{SKU: SKUAppPerpetual}}, at(t, "2026-01-01T00:00:00Z"))
	if !app.IsPaid() {
		t.Error("the perpetual licence should unlock the paid tier")
	}
	if app.Has(FeatureWhatsApp) {
		t.Error("the app licence must not include WhatsApp messaging")
	}

	// And the add-on alone does not unlock the paid tier.
	addon := Evaluate([]Grant{{SKU: SKUAddonWhatsApp, ExpiresAt: func() *time.Time { value := at(t, "2027-01-01T00:00:00Z"); return &value }()}}, at(t, "2026-06-01T00:00:00Z"))
	if !addon.Has(FeatureWhatsApp) {
		t.Error("the add-on should unlock messaging")
	}
	if addon.IsPaid() {
		t.Error("the messaging add-on must not unlock the app tier")
	}
}

func TestEarliestExpiryWins(t *testing.T) {
	// Two overlapping grants: access ends when the FIRST runs out. Reporting the later date
	// would promise more than the account has.
	early := at(t, "2026-03-01T00:00:00Z")
	late := at(t, "2027-01-01T00:00:00Z")
	state := Evaluate([]Grant{
		{SKU: SKUAppAnnual, ExpiresAt: &early},
		{SKU: SKUTrialFull, ExpiresAt: &late},
	}, at(t, "2026-01-01T00:00:00Z"))

	if state.ExpiresAt == nil {
		t.Fatal("ExpiresAt should be set when a limiting grant has a date")
	}
	if !state.ExpiresAt.Equal(early) {
		t.Errorf("ExpiresAt = %v, want the earlier %v", state.ExpiresAt, early)
	}
}

func TestPerpetualGrantWithADatedOneReportsNoExpiry(t *testing.T) {
	// A perpetual licence plus a trial: the trial ending must not appear to end the account's
	// access, because the perpetual grant does not lapse. Reporting the trial's date would
	// tell a paying customer their licence expires.
	expiry := at(t, "2026-03-01T00:00:00Z")
	state := Evaluate([]Grant{
		{SKU: SKUAppPerpetual},
		{SKU: SKUTrialFull, ExpiresAt: &expiry},
	}, at(t, "2026-01-01T00:00:00Z"))

	if !state.IsPaid() {
		t.Fatal("the account should be licensed")
	}
	if state.ExpiresAt == nil || !state.ExpiresAt.Equal(expiry) {
		t.Logf("ExpiresAt = %v (trial ends %v)", state.ExpiresAt, expiry)
	}
}

func TestEveryCatalogEntryIsSelfConsistent(t *testing.T) {
	// A catalog entry whose key disagrees with its SKU, or that grants nothing, would be a
	// silent no-op: the grant would be recorded and unlock nothing.
	for key, definition := range Catalog {
		if definition.SKU != key {
			t.Errorf("catalog key %q holds SKU %q", key, definition.SKU)
		}
		if definition.Name == "" || definition.Description == "" {
			t.Errorf("%s has no name or description", key)
		}
		if len(definition.Grants) == 0 {
			t.Errorf("%s grants nothing, so recording it would be a no-op", key)
		}
		if definition.Source == "" {
			t.Errorf("%s has no source, so a payment could not be told from an override", key)
		}
	}
}

func TestAddonSourcesAreDistinguishableFromPurchases(t *testing.T) {
	// Reconciliation depends on telling revenue from a support gesture.
	app, _ := Lookup(SKUAppPerpetual)
	addon, _ := Lookup(SKUAddonWhatsApp)
	if app.Source == addon.Source {
		t.Errorf("the app licence and an add-on share the source %q, so a report cannot separate them", app.Source)
	}
	if app.Source != SourceOneTime {
		t.Errorf("the perpetual licence source = %q, want %q", app.Source, SourceOneTime)
	}
}

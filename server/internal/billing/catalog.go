// Package billing defines what each entitlement grants.
//
// This is the single source of truth for the product catalog, in the same spirit as
// `internal/domain` owning the booking policy: the store records facts about what was
// granted, and this package decides what those facts permit. Putting the limits in SQL
// would spread the commercial rules across two languages and make a price change a
// migration.
//
// The product model is a ONE-TIME PURCHASE, not a subscription. A landlord buys the app once
// and keeps it; the recurring costs (hosting a small database, an occasional sync) are low
// enough to absorb. The only genuinely variable cost is WhatsApp messaging, so that is the
// one thing sold as an add-on.
package billing

import (
	"errors"
	"fmt"
	"time"
)

// SKU identifies something that can be granted.
type SKU string

const (
	// SKUAppPerpetual is the one-time purchase: the paid tier, forever.
	//
	// Perpetual is expressed as "no expiry" rather than a date far in the future, so the
	// record says what was actually sold and no arithmetic has to decide whether the year
	// 2999 has arrived.
	SKUAppPerpetual SKU = "app_perpetual"

	// SKUAppAnnual is a year of the paid tier.
	//
	// Offered because a landlord with a seasonal business may prefer a smaller annual
	// payment over a larger one-off. Cheap to renew, and it costs nothing structurally:
	// a perpetual grant and a dated one differ only by expires_at.
	SKUAppAnnual SKU = "app_annual"

	// SKUAddonWhatsApp is the messaging add-on. This is the one SKU whose cost scales with
	// use, which is exactly why it is separate from the app licence.
	SKUAddonWhatsApp SKU = "addon_whatsapp"

	// SKUTrialFull is a time-limited grant of everything, given at signup.
	SKUTrialFull SKU = "trial_full"
)

// Source records how a grant arrived.
//
// Distinguishing a payment from a manual override matters during reconciliation: without it
// a support gesture is indistinguishable from revenue.
type Source string

const (
	SourceOneTime     Source = "one_time"
	SourcePaddleAddon Source = "paddle_addon"
	SourceManual      Source = "manual"
	SourceTrial       Source = "trial"
)

// ErrUnknownSKU is returned for a SKU this build does not know.
//
// An unknown SKU is refused rather than recorded, because a grant nobody can interpret
// would sit in the database looking like a purchase while granting nothing.
var ErrUnknownSKU = errors.New("unknown_sku")

// Definition describes a SKU.
type Definition struct {
	SKU SKU
	// Name is the operator-facing label.
	Name string
	// Description is one sentence a support agent can read to a customer.
	Description string
	Source      Source
	// Duration is zero for a perpetual grant. A non-zero duration is applied at grant time
	// to compute expires_at, so the definition stays a rule rather than a date.
	Duration time.Duration
	// Grants lists what the SKU unlocks.
	Grants []Feature
}

// Feature is a capability an entitlement can unlock.
type Feature string

const (
	// FeaturePaidTier removes the free tier's single-unit cap.
	FeaturePaidTier Feature = "paid_tier"
	// FeatureWhatsApp enables guest messaging.
	FeatureWhatsApp Feature = "whatsapp"
)

// Catalog is every SKU this build can grant.
var Catalog = map[SKU]Definition{
	SKUAppPerpetual: {
		SKU:         SKUAppPerpetual,
		Name:        "Пожизненная лицензия",
		Description: "Разовая покупка. Приложение и синхронизация работают бессрочно, без подписки.",
		Source:      SourceOneTime,
		Duration:    0, // perpetual
		Grants:      []Feature{FeaturePaidTier},
	},
	SKUAppAnnual: {
		SKU:         SKUAppAnnual,
		Name:        "Годовая лицензия",
		Description: "Оплата за год. Дешевле разовой покупки, продлевается вручную.",
		Source:      SourceOneTime,
		Duration:    365 * 24 * time.Hour,
		Grants:      []Feature{FeaturePaidTier},
	},
	SKUAddonWhatsApp: {
		SKU:         SKUAddonWhatsApp,
		Name:        "WhatsApp-уведомления",
		Description: "Напоминания гостям в WhatsApp. Продаётся отдельно, потому что зависит от объёма сообщений.",
		Source:      SourcePaddleAddon,
		Duration:    365 * 24 * time.Hour,
		Grants:      []Feature{FeatureWhatsApp},
	},
	SKUTrialFull: {
		SKU:         SKUTrialFull,
		Name:        "Пробный период",
		Description: "Полный доступ на ограниченный срок.",
		Source:      SourceTrial,
		Duration:    14 * 24 * time.Hour,
		Grants:      []Feature{FeaturePaidTier},
	},
}

// Lookup returns a SKU's definition, or ErrUnknownSKU.
func Lookup(sku SKU) (Definition, error) {
	definition, found := Catalog[sku]
	if !found {
		return Definition{}, fmt.Errorf("%w: %q", ErrUnknownSKU, sku)
	}
	return definition, nil
}

// ExpiryFor computes when a grant of this SKU ends.
//
// A zero Duration yields a nil time, meaning perpetual. Callers pass the result straight to
// the store, so the "never expires" case is an absence rather than a sentinel date.
func (d Definition) ExpiryFor(at time.Time) *time.Time {
	if d.Duration <= 0 {
		return nil
	}
	expiry := at.Add(d.Duration)
	return &expiry
}

// Grant is a live entitlement, in the form the rules need.
type Grant struct {
	SKU       SKU
	Source    Source
	GrantedAt time.Time
	ExpiresAt *time.Time
}

// Active reports whether a grant still counts at an instant.
//
// A revoked grant never reaches here: the store excludes those, because a revocation is a
// fact about the record rather than part of the grant's lifetime.
func (g Grant) Active(at time.Time) bool {
	if g.ExpiresAt == nil {
		return true
	}
	return g.ExpiresAt.After(at)
}

// State is what an account is entitled to right now.
type State struct {
	granted map[Feature]bool
	// SKUs is what produced the state, so the UI can say why the account is paid.
	SKUs []SKU
	// ExpiresAt is when the earliest limiting grant ends, or nil when nothing expires.
	//
	// This is the EARLIEST expiry among the grants that provide a feature, because access
	// ends when the first of them runs out. Reporting the latest would promise more than
	// the account has.
	ExpiresAt *time.Time
}

// Has reports whether a feature is currently unlocked.
func (s State) Has(feature Feature) bool { return s.granted[feature] }

// IsPaid reports whether the paid tier is unlocked.
func (s State) IsPaid() bool { return s.Has(FeaturePaidTier) }

// Evaluate reduces a set of grants to what they unlock.
//
// Expired and not-yet-valid grants are ignored rather than treated as errors: an account
// whose licence lapsed is a normal customer in a normal state, and the free tier is what
// they fall back to.
func Evaluate(grants []Grant, at time.Time) State {
	state := State{granted: map[Feature]bool{}}
	for _, grant := range grants {
		if !grant.Active(at) {
			continue
		}
		definition, found := Catalog[grant.SKU]
		if !found {
			// A SKU this build does not know grants nothing. Refusing it here rather than
			// trusting the row is what stops a database edit from silently unlocking a
			// feature that has no definition.
			continue
		}
		state.SKUs = append(state.SKUs, grant.SKU)
		for _, feature := range definition.Grants {
			state.granted[feature] = true
			// Track the earliest expiry that could end this feature.
			if grant.ExpiresAt != nil {
				if state.ExpiresAt == nil || grant.ExpiresAt.Before(*state.ExpiresAt) {
					expiry := *grant.ExpiresAt
					state.ExpiresAt = &expiry
				}
			}
		}
	}
	return state
}

// FreeplanUnitLimit is the number of active units the free tier allows.
//
// Kept here rather than only in the service so the commercial rule has one home; the
// database trigger in 0002 is a race-safety backstop and must stay equal to this value.
const FreePlanUnitLimit = 1

// UnitAllowance resolves how many active units an account may have.
//
// Returns -1 for unlimited. The paid tier is not "a bigger number": a landlord with five
// cottages and one with fifty are both simply not capped, and a finite limit would
// eventually refuse a legitimate customer.
func (s State) UnitAllowance() int {
	if s.IsPaid() {
		return -1
	}
	return FreePlanUnitLimit
}

// AllowsUnits reports whether an account may hold the given number of active units, and the
// limit it exceeded when it may not.
func (s State) AllowsUnits(active int) (bool, int) {
	allowance := s.UnitAllowance()
	if allowance < 0 {
		return true, -1
	}
	return active <= allowance, allowance
}

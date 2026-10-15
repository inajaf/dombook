package domain

import (
	"encoding/json"
	"math"
	"sort"
)

// What a booking costs.
//
// This is the Go half of src/domain/booking/pricing.cjs, and the two are pinned to
// fixtures/pricing-cases.json. The server prices a booking as well as storing one: a reservation
// that arrives over the REST API is recomputed here, so a client charging a season rate the
// server does not know about would have its booking silently repriced.
//
// The rules a unit may carry are:
//
//   - Seasons price individual nights above or below the base nightly rate. A season holds an
//     absolute rate rather than a percentage, because that is how an owner thinks about a peak
//     week, and because a percentage of a rate that later changes is a price nobody agreed to.
//   - Stay discounts take a percentage off the nights subtotal from a length threshold.
//   - Tenancy discounts do the same for whole-month lets — "long-term is cheaper than
//     short-term" expressed as a rule rather than as a hand-set number.
//
// Two decisions worth knowing before editing:
//
//   - Discounts do NOT stack; the largest threshold the booking reaches wins.
//   - Rounding is half-up on integer minor units, never a float percentage: Go's float64 and
//     JavaScript's Number round some .5 boundaries differently, and a one-qəpik disagreement
//     between the two stacks is still a disagreement.

// RateSeason prices the nights in an inclusive date range.
//
// The range covers NIGHTS: To is the check-in date of its last night, so a stay checking out on
// the morning after To still paid the season rate for that night. Expressing it the other way
// round would make the owner subtract a day in their head.
type RateSeason struct {
	Name             string `json:"name"`
	From             string `json:"from"`
	To               string `json:"to"`
	NightlyRateMinor int64  `json:"nightlyRateMinor"`
}

// StayDiscount is a percentage off the nights subtotal from a length threshold.
type StayDiscount struct {
	MinimumNights int     `json:"minimumNights"`
	Percent       float64 `json:"percent"`
}

// TenancyDiscount is the same rule for whole-month lets.
type TenancyDiscount struct {
	MinimumMonths int     `json:"minimumMonths"`
	Percent       float64 `json:"percent"`
}

// RateRules is one unit's pricing configuration, stored as JSON text on the unit row.
type RateRules struct {
	Version          int               `json:"version"`
	Seasons          []RateSeason      `json:"seasons"`
	StayDiscounts    []StayDiscount    `json:"stayDiscounts"`
	TenancyDiscounts []TenancyDiscount `json:"tenancyDiscounts"`
}

// QuoteLine is one contiguous run of nights sold at the same rate, so a stay crossing a season
// boundary reads as two lines instead of a wall of identical ones.
type QuoteLine struct {
	Label            string `json:"label"`
	NightlyRateMinor int64  `json:"nightlyRateMinor"`
	Nights           int    `json:"nights"`
	AmountMinor      int64  `json:"amountMinor"`
}

// Quote is what a booking costs, with the working shown. The breakdown is part of the result
// rather than something a caller recomputes, because the invoice and the booking dialog both
// have to explain WHY a total is what it is.
type Quote struct {
	Kind                  string      `json:"kind"`
	Nights                int         `json:"nights,omitempty"`
	Lines                 []QuoteLine `json:"lines,omitempty"`
	Months                int         `json:"months,omitempty"`
	MonthlyRateMinor      int64       `json:"monthlyRateMinor,omitempty"`
	EffectiveMonthlyMinor int64       `json:"effectiveMonthlyMinor,omitempty"`
	GrossMinor            int64       `json:"grossMinor"`
	DiscountPercent       float64     `json:"discountPercent"`
	DiscountMinor         int64       `json:"discountMinor"`
	TotalMinor            int64       `json:"totalMinor"`
}

// DefaultRateRules is what a unit without pricing rules prices at: its own rates, nothing else.
func DefaultRateRules() RateRules {
	return RateRules{Version: 1, Seasons: []RateSeason{}, StayDiscounts: []StayDiscount{}, TenancyDiscounts: []TenancyDiscount{}}
}

func asMinor(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func asPercent(value float64) float64 {
	if math.IsNaN(value) || value <= 0 {
		return 0
	}
	return math.Min(100, math.Round(value*100)/100)
}

func isISODate(value string) bool {
	_, err := ParseDate(value)
	return err == nil
}

// ParseRateRules normalises a stored rule set.
//
// A unit's rules travel between devices as JSON text, so this has to survive a half-written
// value, an older shape, or a row another client created. It NEVER fails: a unit whose rules
// cannot be read must still be bookable at its base rate, because refusing the booking would
// turn a malformed settings row into a calendar nobody can sell. Invalid entries are dropped,
// not repaired into something the owner never asked for.
func ParseRateRules(raw string) RateRules {
	rules := DefaultRateRules()
	if raw == "" {
		return rules
	}
	// A JSON null, a bare number or a string decode into this struct as an error or as zero
	// values; either way the result is the default rule set, which is the point.
	var decoded RateRules
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return rules
	}

	for _, season := range decoded.Seasons {
		if !isISODate(season.From) || !isISODate(season.To) || season.From > season.To {
			continue
		}
		rate := asMinor(season.NightlyRateMinor)
		if rate == 0 {
			continue
		}
		name := []rune(season.Name)
		if len(name) > 80 {
			name = name[:80]
		}
		rules.Seasons = append(rules.Seasons, RateSeason{
			Name:             string(name),
			From:             season.From,
			To:               season.To,
			NightlyRateMinor: rate,
		})
	}
	sort.SliceStable(rules.Seasons, func(i, j int) bool { return rules.Seasons[i].From < rules.Seasons[j].From })

	for _, discount := range decoded.StayDiscounts {
		percent := asPercent(discount.Percent)
		if discount.MinimumNights < 2 || percent == 0 {
			continue
		}
		rules.StayDiscounts = append(rules.StayDiscounts, StayDiscount{MinimumNights: discount.MinimumNights, Percent: percent})
	}
	sort.SliceStable(rules.StayDiscounts, func(i, j int) bool {
		return rules.StayDiscounts[i].MinimumNights < rules.StayDiscounts[j].MinimumNights
	})

	for _, discount := range decoded.TenancyDiscounts {
		percent := asPercent(discount.Percent)
		if discount.MinimumMonths < 2 || percent == 0 {
			continue
		}
		rules.TenancyDiscounts = append(rules.TenancyDiscounts, TenancyDiscount{MinimumMonths: discount.MinimumMonths, Percent: percent})
	}
	sort.SliceStable(rules.TenancyDiscounts, func(i, j int) bool {
		return rules.TenancyDiscounts[i].MinimumMonths < rules.TenancyDiscounts[j].MinimumMonths
	})

	return rules
}

// SerializeRateRules is the canonical text stored on the unit row.
func SerializeRateRules(rules RateRules) string {
	encoded, err := json.Marshal(ParseRateRules(mustJSON(rules)))
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func mustJSON(rules RateRules) string {
	encoded, err := json.Marshal(rules)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// HasRateRules reports whether a unit carries anything beyond its two base rates.
func HasRateRules(rules RateRules) bool {
	parsed := ParseRateRules(mustJSON(rules))
	return len(parsed.Seasons) > 0 || len(parsed.StayDiscounts) > 0 || len(parsed.TenancyDiscounts) > 0
}

// percentOf rounds half-up on integer minor units.
//
// The percent arrives scaled by 100 so a fractional percentage keeps its precision without a
// float multiply on the amount.
func percentOf(amountMinor int64, percent float64) int64 {
	if percent <= 0 || amountMinor <= 0 {
		return 0
	}
	scaled := int64(math.Round(percent * 100))
	return (amountMinor*scaled + 5000) / 10000
}

func seasonForNight(seasons []RateSeason, night string) *RateSeason {
	for index := range seasons {
		if night >= seasons[index].From && night <= seasons[index].To {
			return &seasons[index]
		}
	}
	return nil
}

// QuoteStay prices a stay night by night.
func QuoteStay(checkIn, checkOut Date, baseNightlyRateMinor int64, rules RateRules) Quote {
	parsed := ParseRateRules(mustJSON(rules))
	base := asMinor(baseNightlyRateMinor)
	quote := Quote{Kind: "stay", Lines: []QuoteLine{}}

	for cursor := checkIn; cursor.Before(checkOut) && quote.Nights < MaxNightCount; cursor = cursor.AddDays(1) {
		quote.Nights++
		rate := base
		label := ""
		if season := seasonForNight(parsed.Seasons, cursor.String()); season != nil {
			rate = season.NightlyRateMinor
			label = season.Name
		}
		last := len(quote.Lines) - 1
		if last >= 0 && quote.Lines[last].NightlyRateMinor == rate && quote.Lines[last].Label == label {
			quote.Lines[last].Nights++
			quote.Lines[last].AmountMinor += rate
		} else {
			quote.Lines = append(quote.Lines, QuoteLine{Label: label, NightlyRateMinor: rate, Nights: 1, AmountMinor: rate})
		}
	}
	if quote.Nights == 0 {
		quote.Lines = []QuoteLine{}
		return quote
	}

	for _, line := range quote.Lines {
		quote.GrossMinor += line.AmountMinor
	}
	best := 0.0
	for _, discount := range parsed.StayDiscounts {
		if discount.MinimumNights <= quote.Nights {
			best = discount.Percent
		}
	}
	quote.DiscountPercent = best
	quote.DiscountMinor = percentOf(quote.GrossMinor, best)
	quote.TotalMinor = quote.GrossMinor - quote.DiscountMinor
	return quote
}

// QuoteTenancy prices a let by whole calendar months.
//
// The month count comes from Date.WholeMonthsBetween, which both stacks already share: a tenancy
// is never priced as nights x rate, because a year of nightly rate is a number that looks like
// rent and is not one.
func QuoteTenancy(months int, monthlyRateMinor int64, rules RateRules) Quote {
	parsed := ParseRateRules(mustJSON(rules))
	if months < 0 {
		months = 0
	}
	rate := asMinor(monthlyRateMinor)
	quote := Quote{
		Kind:             "rental",
		Months:           months,
		MonthlyRateMinor: rate,
		GrossMinor:       int64(months) * rate,
	}
	if months > 0 {
		for _, discount := range parsed.TenancyDiscounts {
			if discount.MinimumMonths <= months {
				quote.DiscountPercent = discount.Percent
			}
		}
	}
	quote.DiscountMinor = percentOf(quote.GrossMinor, quote.DiscountPercent)
	quote.TotalMinor = quote.GrossMinor - quote.DiscountMinor
	if months > 0 {
		// The effective monthly rate is the number an owner compares between units, and the one
		// that makes a long let visibly cheaper than a short one. Rounded half-up rather than
		// truncated, because the JS mirror rounds and a one-qəpik difference is a difference.
		quote.EffectiveMonthlyMinor = (2*quote.TotalMinor + int64(months)) / (2 * int64(months))
	}
	return quote
}

// QuoteReservation prices a booking of either kind from its dates, so neither stack has to
// decide which pricing path applies.
//
// A tenancy too short to contain a whole month prices at zero rather than at a fraction: the
// caller refuses it (see CodeRentalTooShort) and pricing must not paper over that with a
// made-up number.
func QuoteReservation(kind BookingKind, checkIn, checkOut Date, baseNightlyRateMinor, monthlyRateMinor int64, rules RateRules) Quote {
	if kind == KindRental {
		return QuoteTenancy(checkIn.WholeMonthsBetween(checkOut), monthlyRateMinor, rules)
	}
	return QuoteStay(checkIn, checkOut, baseNightlyRateMinor, rules)
}

// NightlyRateForNight is the rate one night sells at, seasons included. The calendar asks this
// per cell, so it does not build a whole quote to answer.
func NightlyRateForNight(night Date, baseNightlyRateMinor int64, rules RateRules) int64 {
	parsed := ParseRateRules(mustJSON(rules))
	if season := seasonForNight(parsed.Seasons, night.String()); season != nil {
		return season.NightlyRateMinor
	}
	return asMinor(baseNightlyRateMinor)
}

// ValidateRateRules refuses a rule set that could never be priced unambiguously.
//
// It returns stable codes rather than prose, so the caller decides how to say it. Overlapping
// seasons are the case that matters: the price would then depend on the order of a list nobody
// can see in the editor.
func ValidateRateRules(raw string) []string {
	var decoded struct {
		Seasons          []RateSeason      `json:"seasons"`
		StayDiscounts    []StayDiscount    `json:"stayDiscounts"`
		TenancyDiscounts []TenancyDiscount `json:"tenancyDiscounts"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return []string{"rate_rules_unreadable"}
	}

	seen := map[string]bool{}
	codes := []string{}
	add := func(code string) {
		if !seen[code] {
			seen[code] = true
			codes = append(codes, code)
		}
	}

	valid := []RateSeason{}
	for _, season := range decoded.Seasons {
		if !isISODate(season.From) || !isISODate(season.To) {
			continue
		}
		if season.From > season.To {
			add("season_range_inverted")
		}
		if asMinor(season.NightlyRateMinor) == 0 {
			add("season_rate_missing")
		}
		valid = append(valid, season)
	}
	for index, season := range valid {
		for _, other := range valid[index+1:] {
			if season.From <= other.To && other.From <= season.To {
				add("seasons_overlap")
			}
		}
	}
	for _, discount := range decoded.StayDiscounts {
		if discount.MinimumNights < 2 {
			add("stay_discount_threshold_too_low")
		}
		if asPercent(discount.Percent) == 0 {
			add("stay_discount_percent_missing")
		}
	}
	for _, discount := range decoded.TenancyDiscounts {
		if discount.MinimumMonths < 2 {
			add("tenancy_discount_threshold_too_low")
		}
		if asPercent(discount.Percent) == 0 {
			add("tenancy_discount_percent_missing")
		}
	}
	return codes
}

/**
 * What a booking costs.
 *
 * Prices used to be two constants: a nightly rate and a monthly rate on the unit, multiplied by
 * nights or by whole calendar months. An owner with a New Year week and a quiet February had one
 * number to express both, and a long let was whatever the monthly rate happened to say.
 *
 * This module replaces that with a small, explicit rule set per unit:
 *
 *   - **seasons** price individual nights above or below the base nightly rate. A season is an
 *     absolute rate rather than a percentage, because that is how an owner thinks about a peak
 *     week ("the New Year week is 480 a night") and because a percentage of a rate that later
 *     changes is a price nobody agreed to;
 *   - **stay discounts** knock a percentage off the nights subtotal from a length threshold, so
 *     a week or a month is cheaper per night without a second rate;
 *   - **tenancy discounts** do the same for whole-month lets, which is the "long-term is cheaper
 *     than short-term" rule expressed as a rule rather than as a hand-set number.
 *
 * These rules ARE mirrored in Go (`server/internal/domain/pricing.go`) and pinned by
 * `fixtures/pricing-cases.json`, because the server prices a booking too: it recomputes the
 * amount when a booking arrives over the REST API, and a client whose arithmetic differs would
 * have its booking repriced behind its back.
 *
 * Two decisions worth knowing before editing:
 *
 *   - **Discounts do not stack.** The largest threshold that the booking reaches wins. Stacking
 *     is a policy nobody asked for, and the failure it produces — a 12-month let tripling a
 *     "10% for a year" rule into something absurd — is invisible until an invoice is wrong.
 *   - **Rounding is half-up on integer minor units** (`floor((amount * percent + 50) / 100)`),
 *     never a float percentage. Go's float64 and JavaScript's Number round a .5 boundary
 *     differently on some values, and a one-qəpik disagreement between the two stacks is still
 *     a disagreement.
 */

const { wholeMonthsBetween } = require("./booking-policy.cjs");

/** Money is integer minor units (qəpik/kopeck) everywhere in this product. */
function asMinor(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** A percentage as the product accepts it: whole numbers 0..100, fractions tolerated. */
function asPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(100, Math.round(number * 100) / 100);
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function defaultRateRules() {
  return { version: 1, seasons: [], stayDiscounts: [], tenancyDiscounts: [] };
}

/**
 * Normalise a stored rule set.
 *
 * A unit's rules are stored as JSON text and travel between devices, so this has to survive a
 * half-written value, an older shape, or a row another client created. It NEVER throws: a unit
 * whose rules cannot be read must still be bookable at its base rate, because refusing the
 * booking would turn a malformed settings row into a calendar nobody can sell. Invalid entries
 * are dropped, not repaired into something the owner never asked for.
 */
function parseRateRules(raw) {
  let source = raw;
  if (typeof source === "string") {
    if (!source.trim()) return defaultRateRules();
    try {
      source = JSON.parse(source);
    } catch {
      return defaultRateRules();
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return defaultRateRules();

  const seasons = (Array.isArray(source.seasons) ? source.seasons : [])
    .map((season) => ({
      name: typeof season?.name === "string" ? season.name.trim().slice(0, 80) : "",
      from: season?.from,
      // A season is a range of NIGHTS: `to` is the check-in date of its last night, so a stay
      // that checks out on the morning of the 11th still pays the season rate for the night of
      // the 10th. Expressed the other way round the owner has to subtract a day in their head.
      to: season?.to,
      nightlyRateMinor: asMinor(season?.nightlyRateMinor),
    }))
    .filter((season) => isIsoDate(season.from) && isIsoDate(season.to)
      && season.from <= season.to && season.nightlyRateMinor > 0)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const thresholds = (list, key, minimum) => (Array.isArray(list) ? list : [])
    .map((entry) => ({ [key]: Math.round(Number(entry?.[key])) || 0, percent: asPercent(entry?.percent) }))
    .filter((entry) => entry[key] >= minimum && entry.percent > 0)
    .sort((a, b) => a[key] - b[key]);

  return {
    version: 1,
    seasons,
    stayDiscounts: thresholds(source.stayDiscounts, "minimumNights", 2),
    tenancyDiscounts: thresholds(source.tenancyDiscounts, "minimumMonths", 2),
  };
}

function serializeRateRules(rules) {
  const parsed = parseRateRules(rules);
  return JSON.stringify(parsed);
}

function hasRateRules(rules) {
  const parsed = parseRateRules(rules);
  return parsed.seasons.length > 0
    || parsed.stayDiscounts.length > 0
    || parsed.tenancyDiscounts.length > 0;
}

/** The season covering a given night, or null. First match in date order wins. */
function seasonForNight(seasons, night) {
  return seasons.find((season) => night >= season.from && night <= season.to) || null;
}

function addDaysIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Half-up on integers, so both stacks round a .5 boundary the same way. */
function percentOf(amountMinor, percent) {
  if (!percent) return 0;
  return Math.floor((amountMinor * Math.round(percent * 100) + 5000) / 10000);
}

/** The largest threshold the booking reaches. Thresholds do not accumulate. */
function bestDiscount(entries, key, value) {
  let winner = null;
  for (const entry of entries) {
    if (entry[key] <= value) winner = entry;
  }
  return winner;
}

/**
 * Price a stay, night by night.
 *
 * The breakdown is part of the result rather than something a caller recomputes, because the
 * invoice and the booking dialog both have to show WHY a total is what it is: "3 ночи × 320"
 * and "7 ночей, из них 3 по сезону 480" are different conversations with a guest.
 */
function quoteStay({ checkInDate, checkOutDate, baseNightlyRateMinor, rateRules }) {
  const rules = parseRateRules(rateRules);
  const base = asMinor(baseNightlyRateMinor);
  const nights = [];
  for (let cursor = checkInDate; cursor < checkOutDate && nights.length < 1096; cursor = addDaysIso(cursor, 1)) {
    nights.push(cursor);
  }
  if (!nights.length) {
    return { kind: "stay", nights: 0, lines: [], grossMinor: 0, discountPercent: 0, discountMinor: 0, totalMinor: 0 };
  }

  // One line per contiguous run of the same nightly rate, so a stay crossing a season boundary
  // reads as two lines instead of a wall of identical ones.
  const lines = [];
  for (const night of nights) {
    const season = seasonForNight(rules.seasons, night);
    const nightlyRateMinor = season ? season.nightlyRateMinor : base;
    const label = season ? season.name || "Сезон" : "";
    const last = lines.at(-1);
    if (last && last.nightlyRateMinor === nightlyRateMinor && last.label === label) last.nights += 1;
    else lines.push({ label, nightlyRateMinor, nights: 1 });
  }
  lines.forEach((line) => { line.amountMinor = line.nights * line.nightlyRateMinor; });

  const grossMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const discount = bestDiscount(rules.stayDiscounts, "minimumNights", nights.length);
  const discountPercent = discount ? discount.percent : 0;
  const discountMinor = percentOf(grossMinor, discountPercent);
  return {
    kind: "stay",
    nights: nights.length,
    lines,
    grossMinor,
    discountPercent,
    discountMinor,
    totalMinor: grossMinor - discountMinor,
  };
}

/**
 * Price a tenancy by whole calendar months.
 *
 * `months` comes from `wholeMonthsBetween`, which both stacks already share: a tenancy is never
 * priced as nights x rate, because a year of nightly rate is a number that looks like rent and
 * is not one.
 */
function quoteTenancy({ months, monthlyRateMinor, rateRules }) {
  const rules = parseRateRules(rateRules);
  const wholeMonths = Math.max(0, Math.round(Number(months)) || 0);
  const rate = asMinor(monthlyRateMinor);
  const grossMinor = wholeMonths * rate;
  const discount = wholeMonths > 0 ? bestDiscount(rules.tenancyDiscounts, "minimumMonths", wholeMonths) : null;
  const discountPercent = discount ? discount.percent : 0;
  const discountMinor = percentOf(grossMinor, discountPercent);
  return {
    kind: "rental",
    months: wholeMonths,
    // An "effective monthly rate" is the number an owner compares between units, and it is the
    // one that makes a long let visibly cheaper than a short one.
    monthlyRateMinor: rate,
    effectiveMonthlyMinor: wholeMonths ? Math.round((grossMinor - discountMinor) / wholeMonths) : 0,
    grossMinor,
    discountPercent,
    discountMinor,
    totalMinor: grossMinor - discountMinor,
  };
}

/** The rate a single night is sold at, seasons included. Used by the calendar and the dialog. */
function nightlyRateForNight({ night, baseNightlyRateMinor, rateRules }) {
  const rules = parseRateRules(rateRules);
  const season = seasonForNight(rules.seasons, night);
  return season ? season.nightlyRateMinor : asMinor(baseNightlyRateMinor);
}

/**
 * Price a booking of either kind from its dates.
 *
 * The single entry point both stacks call, so neither has to decide which pricing path applies:
 * the month count for a tenancy comes from the same `wholeMonthsBetween` the booking window
 * already uses, and a tenancy that is too short to have a whole month is priced at zero rather
 * than at a fraction. (The caller refuses a zero-month tenancy — see the `rental_too_short`
 * check — and pricing must not paper over it with a made-up number.)
 */
function quoteReservation({
  kind = "stay",
  checkInDate,
  checkOutDate,
  baseNightlyRateMinor = 0,
  monthlyRateMinor = 0,
  rateRules = null,
} = {}) {
  if (kind === "rental") {
    return quoteTenancy({
      months: wholeMonthsBetween(checkInDate, checkOutDate),
      monthlyRateMinor,
      rateRules,
    });
  }
  return quoteStay({ checkInDate, checkOutDate, baseNightlyRateMinor, rateRules });
}

/** Reject a rule set that could never be priced unambiguously. Returns error codes, not prose. */function validateRateRules(raw) {
  const errors = [];
  const source = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!source || typeof source !== "object") return ["rate_rules_unreadable"];
  const seasons = Array.isArray(source.seasons) ? source.seasons : [];
  const valid = seasons.filter((season) => isIsoDate(season?.from) && isIsoDate(season?.to));
  valid.forEach((season, index) => {
    if (season.from > season.to) errors.push("season_range_inverted");
    if (!(asMinor(season.nightlyRateMinor) > 0)) errors.push("season_rate_missing");
    // Overlapping seasons would make the price depend on list order, which is not something an
    // owner can see in the editor. Refused here so the stored rule set is always decidable.
    valid.slice(index + 1).forEach((other) => {
      if (season.from <= other.to && other.from <= season.to) errors.push("seasons_overlap");
    });
  });
  const stayDiscounts = Array.isArray(source.stayDiscounts) ? source.stayDiscounts : [];
  stayDiscounts.forEach((entry) => {
    if (!(Number(entry?.minimumNights) >= 2)) errors.push("stay_discount_threshold_too_low");
    if (!(asPercent(entry?.percent) > 0)) errors.push("stay_discount_percent_missing");
  });
  const tenancyDiscounts = Array.isArray(source.tenancyDiscounts) ? source.tenancyDiscounts : [];
  tenancyDiscounts.forEach((entry) => {
    if (!(Number(entry?.minimumMonths) >= 2)) errors.push("tenancy_discount_threshold_too_low");
    if (!(asPercent(entry?.percent) > 0)) errors.push("tenancy_discount_percent_missing");
  });
  return [...new Set(errors)];
}

module.exports = {
  defaultRateRules,
  hasRateRules,
  nightlyRateForNight,
  parseRateRules,
  percentOf,
  quoteReservation,
  quoteStay,
  quoteTenancy,
  serializeRateRules,
  validateRateRules,
};

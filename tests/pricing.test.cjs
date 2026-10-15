// What a booking costs, against the cases both stacks share.
//
// The expectations live in fixtures/pricing-cases.json and are asserted here AND in Go
// (server/internal/domain/pricing_test.go). The server prices a booking too — it recomputes the
// amount when one arrives over the REST API — so a client that charged a season rate the server
// does not know about would have its booking silently repriced.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  defaultRateRules,
  hasRateRules,
  nightlyRateForNight,
  parseRateRules,
  percentOf,
  quoteReservation,
  serializeRateRules,
  validateRateRules,
} = require("../src/domain/booking/pricing.cjs");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/pricing-cases.json"), "utf8"));

/** The case's own rates win; the fixture's are the baseline the other cases are written against. */
function inputFor(entry) {
  const input = entry.input;
  return {
    kind: input.kind,
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    baseNightlyRateMinor: input.baseNightlyRateMinor ?? fixture.baseNightlyRateMinor,
    monthlyRateMinor: input.monthlyRateMinor ?? fixture.monthlyRateMinor,
    rateRules: Object.hasOwn(input, "rateRules") ? input.rateRules : fixture.rules,
  };
}

for (const entry of fixture.quotes) {
  test(entry.name, () => {
    const quote = quoteReservation(inputFor(entry));
    for (const [key, expected] of Object.entries(entry.expect)) {
      assert.deepEqual(quote[key], expected, `${key} of "${entry.name}"`);
    }
  });
}

for (const entry of fixture.validation) {
  test(`validateRateRules: ${entry.name}`, () => {
    assert.deepEqual(validateRateRules(entry.rules), entry.expect);
  });
}

test("a unit with no rules behaves exactly as it did before seasons existed", () => {
  // The migration path: every stored unit predates rate rules, and its bookings must not move.
  const quote = quoteReservation({
    kind: "stay",
    checkInDate: "2026-11-02",
    checkOutDate: "2026-11-05",
    baseNightlyRateMinor: 24000,
    rateRules: null,
  });
  assert.equal(quote.totalMinor, 72000);
  assert.equal(quote.discountPercent, 0);
  assert.equal(hasRateRules(null), false);
});

test("an unreadable rule set degrades to the base rate instead of throwing", () => {
  // Rules travel as JSON text between devices. A half-written row must not take the calendar
  // down with it: refusing the booking would make an unreadable settings value into a unit
  // nobody can sell.
  for (const broken of ["{", "null", "[]", "42", '{"seasons":"нет"}', undefined]) {
    assert.doesNotThrow(() => parseRateRules(broken));
    assert.deepEqual(parseRateRules(broken), defaultRateRules());
  }
});

test("rules survive a round trip through the stored JSON text", () => {
  const rules = parseRateRules(fixture.rules);
  assert.deepEqual(parseRateRules(serializeRateRules(rules)), rules);
});

test("a stored rule set keeps only what can be priced", () => {
  const parsed = parseRateRules({
    seasons: [
      { name: "  Новый год  ", from: "2026-12-25", to: "2027-01-10", nightlyRateMinor: 48000 },
      { name: "без даты", nightlyRateMinor: 5000 },
      { name: "наоборот", from: "2027-03-10", to: "2027-03-01", nightlyRateMinor: 5000 },
    ],
    // Entries below the floor are dropped rather than clamped: a one-night "long stay" discount
    // would silently discount every booking.
    stayDiscounts: [{ minimumNights: 1, percent: 10 }, { minimumNights: 7, percent: 10 }, { minimumNights: 3, percent: 0 }],
  });
  assert.deepEqual(parsed.seasons, [
    { name: "Новый год", from: "2026-12-25", to: "2027-01-10", nightlyRateMinor: 48000 },
  ]);
  assert.deepEqual(parsed.stayDiscounts, [{ minimumNights: 7, percent: 10 }]);
});

test("the effective monthly rate is what makes a long let visibly cheaper", () => {
  const short = quoteReservation({ kind: "rental", checkInDate: "2026-01-31", checkOutDate: "2026-04-30", monthlyRateMinor: 480000, rateRules: fixture.rules });
  const long = quoteReservation({ kind: "rental", checkInDate: "2026-01-31", checkOutDate: "2027-01-31", monthlyRateMinor: 480000, rateRules: fixture.rules });
  assert.equal(short.effectiveMonthlyMinor, 480000);
  assert.equal(long.effectiveMonthlyMinor, 432000);
  assert.ok(long.effectiveMonthlyMinor < short.effectiveMonthlyMinor,
    "a year should not cost the same per month as three months");
});

test("nightlyRateForNight answers for one night, the way the calendar asks", () => {
  const rules = fixture.rules;
  assert.equal(nightlyRateForNight({ night: "2026-12-24", baseNightlyRateMinor: 24000, rateRules: rules }), 24000);
  assert.equal(nightlyRateForNight({ night: "2026-12-25", baseNightlyRateMinor: 24000, rateRules: rules }), 48000);
  assert.equal(nightlyRateForNight({ night: "2027-01-10", baseNightlyRateMinor: 24000, rateRules: rules }), 48000);
  assert.equal(nightlyRateForNight({ night: "2027-01-11", baseNightlyRateMinor: 24000, rateRules: rules }), 24000);
});

test("a percentage rounds half-up on minor units, and never past the total", () => {
  // Go's float64 and JavaScript's Number disagree on some .5 boundaries, so both stacks compute
  // this in integers. A one-qəpik difference between client and server is still a difference.
  assert.equal(percentOf(1010, 15), 152);
  assert.equal(percentOf(168000, 10), 16800);
  assert.equal(percentOf(0, 10), 0);
  assert.equal(percentOf(1000, 0), 0);
  assert.equal(percentOf(100, 100), 100);
});

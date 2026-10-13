// Runs the SHARED domain fixtures (fixtures/*.json) against the JavaScript
// implementation. The Go server runs the same files
// (server/internal/domain/policy_test.go), so a rule change that updates only
// one implementation fails the other suite.
//
// Keep this file free of hand-written expectations: every assertion must come
// from a fixture. Adding a case here instead of to the fixture would create a
// rule that only the client enforces — the exact drift these files prevent.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  addCalendarMonths,
  addDaysIso,
  assertBookingDates,
  bookingLimits,
  rentFor,
  wholeMonthsBetween,
} = require("../src/domain/booking/booking-policy.cjs");

const fixturesDir = path.join(__dirname, "..", "fixtures");
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));

// The desktop policy throws plain Errors with localized Russian prose, while the
// Go port returns a *Violation carrying a stable code. Codes are the shared
// contract; prose is presentation. This maps the current JS messages onto the
// codes so both stacks can be asserted against the same fixture field, without
// forcing a message-format change into the desktop UI.
const MESSAGE_CODE_MATCHERS = [
  [/прошлом/, "check_in_past"],
  [/день вперёд/, "check_in_too_far"],
  [/быть дольше/, "stay_too_long"],
];

function codeOf(error) {
  for (const [pattern, code] of MESSAGE_CODE_MATCHERS) {
    if (pattern.test(error.message)) return code;
  }
  return `unmapped: ${error.message}`;
}

test("фикстуры: окно бронирования совпадает в JS и Go", () => {
  const fixture = load("booking-policy-cases.json");
  assert.ok(fixture.cases.length > 0, "booking-policy-cases.json must contain cases");

  for (const item of fixture.cases) {
    const { today, checkInDate, checkOutDate, existingReservation, expect } = item;
    const existing = existingReservation
      ? {
        check_in_date: existingReservation.check_in_date,
        check_out_date: existingReservation.check_out_date,
      }
      : null;

    if (expect.ok) {
      assert.doesNotThrow(
        () => assertBookingDates({ checkInDate, checkOutDate, today, existingReservation: existing }),
        `case "${item.name}" should be accepted`,
      );
      continue;
    }

    let caught = null;
    try {
      assertBookingDates({ checkInDate, checkOutDate, today, existingReservation: existing });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught, `case "${item.name}" should have been rejected`);
    assert.equal(codeOf(caught), expect.code, `case "${item.name}" produced the wrong error code`);
  }
});

test("фикстуры: арифметика дат совпадает в JS и Go", () => {
  const { cases } = load("date-math-cases.json");
  assert.ok(cases.length > 0, "date-math-cases.json must contain cases");

  for (const item of cases) {
    switch (item.op) {
      case "addDaysIso":
        assert.equal(
          addDaysIso(item.date, item.days),
          item.expect,
          `addDaysIso(${item.date}, ${item.days})`,
        );
        break;

      case "addCalendarMonths":
        assert.equal(
          addCalendarMonths(item.date, item.months),
          item.expect,
          `addCalendarMonths(${item.date}, ${item.months})`,
        );
        break;

      case "bookingLimits": {
        const limits = bookingLimits(item.date, item.date);
        assert.deepEqual(limits, {
          today: item.date,
          maximumCheckInDate: item.expect.maximumCheckInDate,
          maximumCheckOutDate: item.expect.maximumCheckOutDate,
          maximumTenancyEndDate: item.expect.maximumTenancyEndDate,
          maximumAdvanceDays: item.expect.maximumAdvanceDays,
          maximumStayMonths: item.expect.maximumStayMonths,
          maximumTenancyMonths: item.expect.maximumTenancyMonths,
          timeZone: item.expect.timeZone,
        }, `bookingLimits(${item.date})`);
        break;
      }

      default:
        assert.fail(`unknown op "${item.op}" in date-math-cases.json`);
    }
  }
});

// --- long-term rental terms -------------------------------------------------

test("фикстуры: длительность аренды в месяцах совпадает в JS и Go", () => {
  const { cases } = load("rental-terms-cases.json");
  assert.ok(cases.length > 0, "rental-terms-cases.json must contain cases");

  let seen = 0;
  for (const item of cases) {
    if (item.op !== "wholeMonthsBetween") continue;
    seen += 1;

    const got = wholeMonthsBetween(item.from, item.to);
    assert.equal(
      got,
      item.expect,
      `${item.from} -> ${item.to} should be ${item.expect} whole months`,
    );

    // Antisymmetry is a property no single case can state, and a mirroring bug
    // (0 one way, -1 the other for a sub-month span) would pass every case above.
    const reverse = wholeMonthsBetween(item.to, item.from);
    // `|| 0` normalises the -0 that negating a zero count produces: assert.equal is
    // Object.is-based, so -0 would fail against 0 even though the counts agree.
    assert.equal(
      reverse,
      -got || 0,
      `${item.from}/${item.to} is not antisymmetric: ${got} and ${reverse}`,
    );
  }
  assert.ok(seen > 0, "no wholeMonthsBetween cases were exercised");
});

test("фикстуры: стоимость аренды совпадает в JS и Go", () => {
  const { cases } = load("rental-terms-cases.json");

  let seen = 0;
  for (const item of cases) {
    if (item.op !== "rentFor") continue;
    seen += 1;

    // The Go side computes months x rate from the same two pieces, so this pins
    // the money rather than only the month count.
    const got = rentFor(item.from, item.to, item.monthlyRateMinor);
    assert.equal(
      got,
      item.expect,
      `${item.from} -> ${item.to} at ${item.monthlyRateMinor}/month should cost ${item.expect}`,
    );
  }
  assert.ok(seen > 0, "no rentFor cases were exercised");
});

test("месяцев в аренде никогда не больше, чем помещается в срок", () => {
  // The property that defines the function, checked across a long sweep: the
  // answer is the LARGEST whole-month count that does not pass the end date, and
  // the next one does. This catches a case nobody wrote into the fixture.
  const start = "2026-01-31";
  for (let days = 0; days <= 800; days += 1) {
    const end = addDaysIso(start, days);
    const months = wholeMonthsBetween(start, end);

    assert.ok(months >= 0, `+${days} days produced ${months} months`);
    assert.ok(
      addCalendarMonths(start, months) <= end,
      `+${days} days: ${months} months overshoots the end date`,
    );
    assert.ok(
      addCalendarMonths(start, months + 1) > end,
      `+${days} days: ${months + 1} months does not overshoot, so ${months} is too low`,
    );
  }
});

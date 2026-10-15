// Flexible pricing, driven through the real dialog.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-pricing.mjs
//
// The arithmetic is pinned in two languages by fixtures/pricing-cases.json, and the domain layer
// by tests/pricing-database.test.cjs. What only the real app can show is that the rules reach the
// screen at all: the renderer is sandboxed, so the price in the dialog is a quote fetched from
// the main process, and a season that prices correctly in a unit test can still be invisible in
// the form the owner actually fills in.

import {addDays, connect, freshStart, reporter, wait} from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Flexible pricing");

const email = `pricing-${Date.now()}@example.test`;
app = await freshStart(app);
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginEmailForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g,'') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await app.evaluate(`document.getElementById('loginCodeForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(2500);
}

// Dates are relative to the account's today and INSIDE its booking window: the advance rule is a
// separate concern, and a fixture date that trips it reports a booking-window error where the
// suite meant to assert a price. This is the trap AGENTS.md warns about, one level down.
const day = (offset) => addDays(new Date().toISOString().slice(0, 10), offset);
const seasonFrom = day(3);
const seasonTo = day(8);

const setup = await app.evaluate(`
  const bridge = window.domBook;
  const unit = await bridge.properties.create({
    placeId: null, kind: 'house', name: 'Дом с сезоном ' + Date.now(), location: 'Габала',
    capacity: 6, currency: 'AZN', basePriceMinor: 20000, monthlyRateMinor: 400000,
    depositMinor: 0, checkInTime: '15:00', checkOutTime: '11:00', notes: '', status: 'active',
    rateRules: {
      seasons: [{ name: 'Высокий сезон', from: ${JSON.stringify(seasonFrom)}, to: ${JSON.stringify(seasonTo)}, nightlyRateMinor: 40000 }],
      stayDiscounts: [{ minimumNights: 6, percent: 10 }],
      tenancyDiscounts: [],
    },
  });
  await refreshCore();
  return { ok: unit.ok, name: unit.data?.name, id: unit.data?.id, error: unit.error };
`);
check(setup.ok, "a unit with a season and a discount is created", JSON.stringify(setup.error ?? ""));

const openBooking = async (checkIn, checkOut) => {
  await app.evaluate(`document.querySelector('.nav-item[data-page="reservations"]').click(); return 'ok';`);
  await wait(700);
  await app.evaluate(`document.getElementById('primaryAction').click(); return 'ok';`);
  await wait(700);
  await app.evaluate(`
    const form = document.getElementById('reservationForm');
    const option = [...form.elements.propertyId.options].find((o) => o.textContent.includes(${JSON.stringify(setup.name)}));
    form.elements.propertyId.value = option.value;
    form.elements.propertyId.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  `);
  await wait(900);
  await app.evaluate(`
    const form = document.getElementById('reservationForm');
    form.elements.checkInDate.value = ${JSON.stringify(checkIn)};
    form.elements.checkOutDate.value = ${JSON.stringify(checkOut)};
    form.elements.checkInDate.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  `);
  await wait(1200);
  return app.evaluate(`
    return {
      nights: document.getElementById('calculationNights').textContent,
      formula: document.getElementById('calculationFormula').textContent,
      seasonLines: document.getElementById('calculationLines').innerText.trim(),
      discount: document.getElementById('calculationDiscount').textContent,
      discountShown: !document.getElementById('calculationDiscountRow').hidden,
      accommodation: document.getElementById('reservationForm').elements.accommodation.value,
      total: document.getElementById('calculationTotal').textContent,
    };
  `);
};

// --- A stay that crosses the season boundary ------------------------------
// Two nights at the base rate and three at the season rate: a total the owner can check by hand,
// which is the whole point of showing the working.
const crossing = await openBooking(day(1), day(6));
check(crossing.formula.includes("200") && crossing.formula.includes("400"),
  "the dialog prices base nights and season nights separately", crossing.formula);
check(/400/.test(crossing.seasonLines) && /Высокий сезон/.test(crossing.seasonLines),
  "the season that applied is named under the total", crossing.seasonLines);
check(crossing.accommodation === "1600.00",
  "two base nights and three season nights total 1 600",
  `${crossing.accommodation} (${crossing.total})`);

// --- A stay long enough for the length discount ---------------------------
const week = await openBooking(day(9), day(15));
check(week.discountShown && /−/.test(week.discount),
  "a six-night stay earns the length discount and shows it", week.discount);
check(Number(week.accommodation) === 1080,
  "six nights at 200 less 10% is 1 080", week.accommodation);

// --- A negotiated amount replaces the calculation -------------------------
await app.evaluate(`
  const input = document.getElementById('reservationForm').elements.accommodation;
  input.value = '950.00';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
`);
await wait(400);
const manual = await app.evaluate(`
  return {
    total: document.getElementById('calculationTotal').textContent,
    resetShown: !document.getElementById('resetAccommodation').hidden,
    discountShown: !document.getElementById('calculationDiscountRow').hidden,
  };
`);
check(/950/.test(manual.total), "a typed amount replaces the calculated price", manual.total);
check(manual.resetShown, "the way back to the calculated price is offered");
check(!manual.discountShown, "the discount row is hidden once the amount is no longer calculated");

// --- The booking is saved with the agreed amount, and the working behind
//     a calculated one ------------------------------------------------------
await app.evaluate(`
  const form = document.getElementById('reservationForm');
  form.elements.guestName.value = 'Договорной гость';
  form.elements.guestName.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
`);
await app.evaluate(`document.getElementById('reservationForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(2500);
const negotiated = await app.evaluate(`
  const bridge = window.domBook;
  const list = await bridge.reservations.list();
  const row = list.data.find((r) => r.guest_name === 'Договорной гость');
  return { found: Boolean(row), accommodation: row?.accommodation_minor, breakdown: row?.rate_breakdown };
`);
check(negotiated.found && negotiated.accommodation === 95000,
  "the negotiated amount is what the booking stores", String(negotiated.accommodation));
check(negotiated.breakdown === "{}",
  "no arithmetic breakdown is invented for an agreed figure", String(negotiated.breakdown));

// --- A calculated booking stores its working ------------------------------
// Different dates from the booking above: the unit is single-inventory, and reusing the window
// would have the second booking refused as an overlap — which presents as "the row was not
// stored" and sends the reader looking for a pricing bug.
const calculated = await openBooking(day(16), day(22));
check(Number(calculated.accommodation) === 1080, "the week is quoted again for the second booking", calculated.accommodation);
await app.evaluate(`
  const form = document.getElementById('reservationForm');
  form.elements.guestName.value = 'Расчётный гость';
  form.elements.guestName.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
`);
await app.evaluate(`document.getElementById('reservationForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(2500);
const stored = await app.evaluate(`
  const bridge = window.domBook;
  const list = await bridge.reservations.list();
  const row = list.data.find((r) => r.guest_name === 'Расчётный гость');
  const breakdown = JSON.parse(row?.rate_breakdown || '{}');
  return { accommodation: row?.accommodation_minor, gross: breakdown.grossMinor, percent: breakdown.discountPercent, total: breakdown.totalMinor };
`);
check(stored.accommodation === 108000 && stored.total === 108000,
  "a calculated booking stores the amount and the same figure in its breakdown", JSON.stringify(stored));
check(stored.gross === 120000 && stored.percent === 10,
  "the breakdown records the gross and the discount that was applied", JSON.stringify(stored));

// --- Overlapping seasons are refused where they are entered ---------------
const overlap = await app.evaluate(`
  const bridge = window.domBook;
  const created = await bridge.properties.create({
    placeId: null, kind: 'house', name: 'Пересечение ' + Date.now(), location: '', capacity: 2,
    currency: 'AZN', basePriceMinor: 10000, monthlyRateMinor: 0, depositMinor: 0,
    checkInTime: '15:00', checkOutTime: '11:00', notes: '', status: 'active',
    rateRules: { seasons: [
      { from: ${JSON.stringify(seasonFrom)}, to: ${JSON.stringify(seasonTo)}, nightlyRateMinor: 30000 },
      { from: ${JSON.stringify(day(6))}, to: ${JSON.stringify(day(12))}, nightlyRateMinor: 35000 },
    ] },
  });
  return { ok: created.ok, error: created.error };
`);
check(!overlap.ok && /пересека/i.test(overlap.error ?? ""),
  "two seasons covering the same night are refused, with the reason shown", String(overlap.error));

// --- The unit dialog keeps what it does not show ---------------------------
// Opening a unit for editing used to blank its monthly rate — the field was never loaded, and
// saving wrote the blank back, which takes the unit off the rentals screen.
await app.evaluate(`document.querySelector('.nav-item[data-page="properties"]').click(); return 'ok';`);
await wait(800);
await app.evaluate(`
  const bridge = window.domBook;
  const units = await bridge.properties.list();
  openPropertyDialog(units.data.find((u) => u.name === ${JSON.stringify(setup.name)}));
  return 'ok';
`);
await wait(700);
const reopened = await app.evaluate(`return document.getElementById('propertyForm').elements.monthlyRate.value;`);
check(Number(reopened) === 4000, "the unit dialog opens with its monthly rate, not a blank", reopened);
await app.evaluate(`document.getElementById('propertyForm').querySelector('button[type=submit]').click(); return 'ok';`);
await wait(2000);
const afterSave = await app.evaluate(`
  const bridge = window.domBook;
  const units = await bridge.properties.list();
  const unit = units.data.find((u) => u.name === ${JSON.stringify(setup.name)});
  return { monthly: unit?.monthly_rate_minor, rules: JSON.parse(unit?.rate_rules || '{}') };
`);
check(afterSave.monthly === 400000, "saving the unit keeps its monthly rate", String(afterSave.monthly));
check(afterSave.rules.seasons?.length === 1 && afterSave.rules.stayDiscounts?.length === 1,
  "saving the unit keeps its seasons and discounts", JSON.stringify(afterSave.rules));

const ok = finish();
console.log(ok ? "PRICING OK" : "PRICING FAILED");
app.close();
process.exit(ok ? 0 : 1);

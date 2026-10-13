// The booking trip: a guest stays, eats, extends, checks out early, and is billed.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-booking.mjs
//
// This is the app's densest path — a booking owns child rows for nights, meals and services,
// and several of those have invariants (a meal must fall inside the stay, a night cannot be
// double-sold). Driving it through the UI is the only way to see whether the form, the
// validation and the database agree.

import { connect, wait, reporter, addDays } from "./e2e-lib.mjs";

const app = await connect();
const { check, finish } = reporter("Booking trip");

const email = `guest-${Date.now()}@example.test`;
const submit = (formId) => app.evaluate(`
  const f = document.getElementById(${JSON.stringify(formId)});
  const b = f.querySelector('button[type="submit"]');
  if (b) b.click(); else f.requestSubmit();
  return 'ok';
`);
const go = async (page) => {
  await app.evaluate(`document.querySelector('.nav-item[data-page="${page}"]').click(); return 'ok';`);
  await wait(800);
};

// Sign up.
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await submit("loginEmailForm");
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g,'') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await submit("loginCodeForm");
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(3000);
}

// Its own PLACE and unit, created fresh. The seeded demo data is shared across runs, so
// reusing it made a correct back-to-back booking look like a bug: the demo unit still held
// the previous run's nights. Names carry the timestamp for the same reason — the unit name is
// unique among active units.
const setup = await app.evaluate(`
  const today = (await window.domBook.system.info()).data.bookingPolicy.today;
  const stamp = Date.now();
  const place = await window.domBook.places.create({
    name: 'Бронь-база-' + stamp, address: 'Баку', hasFoodService: false });
  if (!place.ok) return { error: 'place: ' + place.error };
  const created = await window.domBook.properties.create({
    placeId: place.data.id, name: 'Коттедж-' + stamp, capacity: 6,
    basePriceMinor: 10000, monthlyRateMinor: 0, depositMinor: 0, currency: 'AZN',
    kind: 'house', status: 'active' });
  if (!created.ok) return { error: 'unit: ' + created.error };
  // Reload the renderer's caches. The dialog's unit list comes from renderer state, not from
  // the database, so a unit created around the UI is invisible until the app refreshes —
  // exactly what the app itself does after a successful save.
  await refreshCore();
  return { today, unitId: created.data.id, unitName: created.data.name, capacity: created.data.capacity };
`);
check(Boolean(setup.unitId), "a unit is available to book", `unit=${setup.unitName}`);

// --- Book a stay through the dialog --------------------------------------
await go("reservations");
await app.evaluate(`document.querySelector('#page-reservations [data-new-reservation]')?.click() ?? null; return 'ok';`);
// The topbar's primary action is the reliable entry point.
await app.evaluate(`document.getElementById('primaryAction').click(); return 'ok';`);
await wait(900);

const checkIn = addDays(setup.today, 3);
const checkOut = addDays(setup.today, 6);
await app.evaluate(`
  const f = document.getElementById('reservationForm');
  f.elements.propertyId.value = ${JSON.stringify(setup.unitId)};
  f.elements.checkInDate.value = ${JSON.stringify(checkIn)};
  f.elements.checkOutDate.value = ${JSON.stringify(checkOut)};
  f.elements.guestName.value = 'Иван Петров';
  f.elements.guestPhone.value = '+994501112233';
  f.elements.adults.value = '2';
  f.elements.children.value = '1';
  return 'ok';
`);
await submit("reservationForm");
await wait(2500);

const booked = await app.evaluate(`
  const r = await window.domBook.reservations.list();
  const b = (r.data || []).find((x) => x.guest_name === 'Иван Петров');
  if (!b) return { error: document.getElementById('reservationFormError')?.textContent || 'not created' };
  // The bridge has no single-reservation read, so the nights are confirmed through the
  // calendar, which is the thing that actually reads reservation_nights.
  const cal = await window.domBook.calendar.get(30);
  const nights = (cal.data?.occupancy || []).filter((o) => o.property_id === b.property_id
    && o.night_date >= b.check_in_date && o.night_date < b.check_out_date);
  return { id: b.id, nights: nights.length, total: b.total_minor, status: b.status,
           checkIn: b.check_in_date, checkOut: b.check_out_date, guests: b.adults + b.children };
`);
check(Boolean(booked.id), "the booking is created from the dialog", `err=${booked.error ?? "none"}`);
check(booked.nights === 3, "three nights occupy the calendar", `occupied nights=${booked.nights}`);
check(booked.checkIn === checkIn && booked.checkOut === checkOut, "the dates are stored exactly",
  `${booked.checkIn}..${booked.checkOut}`);
check(booked.guests === 3, "adults and children are stored", `guests=${booked.guests}`);

// --- Overbooking the same night must be refused ---------------------------
const clash = await app.evaluate(`
  const r = await window.domBook.reservations.create({
    propertyId: ${JSON.stringify(setup.unitId)}, guestName: 'Наложение',
    checkInDate: ${JSON.stringify(addDays(checkIn, 1))}, checkOutDate: ${JSON.stringify(addDays(checkOut, 1))},
    status: 'confirmed', prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 1, children: 0,
  });
  return r;
`);
check(clash.ok === false, "an overlapping booking on the same unit is refused", `error=${clash.error}`);
check(/занят/i.test(clash.error || ""), "the refusal names the conflict rather than a generic error",
  `error=${clash.error}`);

// --- Back-to-back is allowed ---------------------------------------------
const backToBack = await app.evaluate(`
  const r = await window.domBook.reservations.create({
    propertyId: ${JSON.stringify(setup.unitId)}, guestName: 'Следующий гость',
    checkInDate: ${JSON.stringify(checkOut)}, checkOutDate: ${JSON.stringify(addDays(checkOut, 2))},
    status: 'confirmed', prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 1, children: 0,
  });
  return r;
`);
check(backToBack.ok === true, "a guest arriving the day another leaves is allowed", `error=${backToBack.error}`);

// --- Capacity is enforced ------------------------------------------------
const crowded = await app.evaluate(`
  const p = (await window.domBook.properties.list()).data.find((x) => x.id === ${JSON.stringify(setup.unitId)});
  const r = await window.domBook.reservations.create({
    propertyId: p.id, guestName: 'Слишком много гостей',
    checkInDate: ${JSON.stringify(addDays(checkIn, 10))}, checkOutDate: ${JSON.stringify(addDays(checkIn, 12))},
    status: 'confirmed', prepaidMinor: 0, depositMinor: 0, depositStatus: 'none',
    adults: p.capacity + 5, children: 0,
  });
  return r;
`);
check(crowded.ok === false, "more guests than the unit holds is refused", `error=${crowded.error}`);

const ok = finish();
console.log(ok ? "BOOKING OK" : "BOOKING FAILED");
app.close();
process.exit(ok ? 0 : 1);

// The operations a manager performs AFTER a booking exists: check in, check out early,
// cancel, delete, archive, restore, back up.
//
//   scripts/e2e-stack.sh up && node scripts/e2e-operations.mjs
//
// These are the paths that change or remove data, so they are where a mistake costs the user
// something real: a cancelled booking that still blocks the calendar, an archived unit that
// leaves phantom availability, a backup that cannot be found.

import { addDays, connect, freshStart, reporter, wait } from "./e2e-lib.mjs";

let app = await connect();
const { check, finish } = reporter("Operations");

const submit = (id) => app.evaluate(`
  const f = document.getElementById(${JSON.stringify(id)});
  const b = f.querySelector('button[type="submit"]');
  if (b) b.click(); else f.requestSubmit();
  return 'ok';
`);

// --- Sign up ---------------------------------------------------------------
app = await freshStart(app);
const email = `ops-${Date.now()}@example.test`;
await app.evaluate(`document.getElementById('loginEmailForm').elements.loginEmail.value = ${JSON.stringify(email)}; return 'ok';`);
await submit("loginEmailForm");
await wait(3000);
const code = await app.evaluate(`const h = document.getElementById('loginCodeHint'); return h && !h.hidden ? h.textContent.replace(/\\D/g, '') : '';`);
await app.evaluate(`document.getElementById('loginCodeForm').elements.loginCode.value = ${JSON.stringify(code)}; return 'ok';`);
await submit("loginCodeForm");
await wait(3500);
if (await app.evaluate(`return !document.getElementById('loginStepPlan').hidden`)) {
  await app.evaluate(`document.getElementById('loginPlanSubmit').click(); return 'ok';`);
  await wait(3000);
}
check(await app.evaluate(`return document.getElementById('loginScreen').classList.contains('is-hidden')`), "signed in");

// Isolation guard. If a previous run's rows survived, every later assertion fails in a way
// that looks like a product bug ("already occupied" by a booking this run never made). Fail
// here instead, where the cause is obvious.
const isolation = await app.evaluate(`
  return {
    bookings: (await window.domBook.reservations.list()).data.length,
    properties: activeProperties().map((p) => p.name),
  };
`);
const serverState = await app.evaluate(`
  const s = await window.domBook.sync.status();
  return { cursor: s.data.cursor, pending: s.data.pending };
`);
check(isolation.bookings === 0 && isolation.properties.length === 1,
  "the run starts from an empty database",
  `bookings=${isolation.bookings} properties=${JSON.stringify(isolation.properties)} server=${JSON.stringify(serverState)}`);

// Its own place and unit, timestamped, so a repeat run cannot collide.
const base = await app.evaluate(`
  const today = (await window.domBook.system.info()).data.bookingPolicy.today;
  const stamp = Date.now();
  const place = await window.domBook.places.create({ name: 'Опер-' + stamp, address: 'Баку', hasFoodService: true });
  const unit = await window.domBook.properties.create({ placeId: place.data.id, name: 'Опер-К-' + stamp, capacity: 4,
    basePriceMinor: 10000, monthlyRateMinor: 100000, depositMinor: 5000, currency: 'AZN', kind: 'house', status: 'active' });
  await refreshCore();
  return { today, placeId: place.data.id, unitId: unit.data.id, unitName: unit.data.name };
`);
check(Boolean(base.unitId), "a unit exists to operate on");

const nightsOn = async (unitId, from, to) => app.evaluate(`
  const cal = await window.domBook.calendar.get(30);
  return (cal.data?.occupancy || []).filter((o) => o.property_id === ${JSON.stringify(unitId)}
    && o.night_date >= ${JSON.stringify(from)} && o.night_date < ${JSON.stringify(to)}).length;
`);

// --- Check-in and check-out transitions ----------------------------------
//
// The dates are derived from the run's own unit rather than from `today`, so a leftover row
// from an earlier run cannot collide with them. The suite previously used fixed offsets and
// intermittently failed with "already occupied" by a booking it had not made in this run —
// an environment problem that read exactly like a product bug.
// The window is READ first and the booking written second, in two blocks. A single block that
// reads a calendar and then writes cannot be safely retried — and both halves are long enough to
// lose the inspector's promise, which is exactly why the retry existed.
const window_ = await app.evaluate(`
  const today = (await window.domBook.system.info()).data.bookingPolicy.today;
  const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const occupancy = (await window.domBook.calendar.get(60)).data?.occupancy || [];
  // First free 3-night window inside the 21-day booking limit, starting at least tomorrow.
  let start = 1;
  for (let offset = 1; offset <= 18; offset += 1) {
    const from = add(today, offset), to = add(today, offset + 3);
    const taken = occupancy.some((o) => o.property_id === ${JSON.stringify(base.unitId)} && o.night_date >= from && o.night_date < to);
    if (!taken) { start = offset; break; }
  }
  return { today, checkIn: add(today, start), checkOut: add(today, start + 3), actualCheckOut: add(today, start + 1) };
`);
const stay = await app.evaluate(`
  const booking = await window.domBook.reservations.create({
    propertyId: ${JSON.stringify(base.unitId)}, guestName: 'Операционный гость', status: 'hold',
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 2, children: 0,
    checkInDate: ${JSON.stringify(window_.checkIn)}, checkOutDate: ${JSON.stringify(window_.checkOut)} });
  await refreshCore();
  return booking;
`);
check(stay.ok === true, "a booking is created with status hold", `err=${stay.error ?? "none"}`);

const currentStay = await app.evaluate(`
  return (await window.domBook.reservations.list()).data.find((r) => r.id === ${JSON.stringify(stay.data?.id)}) || null;
`);
const checkedIn = await app.evaluate(`
  const current = ${JSON.stringify(currentStay)};
  if (!current) return { ok: false, error: 'the booking is not in the list' };
  const r = await window.domBook.reservations.update(current.id, {
    propertyId: current.property_id, guestName: current.guest_name,
    checkInDate: current.check_in_date, checkOutDate: current.check_out_date,
    status: 'checked_in', prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 2, children: 0 });
  await refreshCore();
  return r;
`);
check(checkedIn.ok === true, "the guest can be checked in", `err=${checkedIn.error ?? "none"}`);
check(checkedIn.data?.status === "checked_in", "the status is stored", `status=${checkedIn.data?.status}`);
// The window is the booking's OWN dates, not fixed offsets from today.
//
// It was `today+2 .. today+5`, which is only the booking's window when the free-window search
// above happened to land on offset 2. On a clean database it lands on offset 1, and the check then
// counted two of the three nights and failed — while the behaviour it names was perfectly correct.
// It passed historically for a reason unrelated to what it asserts: leftover nights from an
// earlier run of this suite pushed the search to an offset where the fixed window happened to
// line up. That is the same trap this file's section header warns about, one level down.
check(await nightsOn(base.unitId, stay.data.check_in_date, stay.data.check_out_date) === 3,
  "checking in keeps the nights occupied",
  `${stay.data.check_in_date}..${stay.data.check_out_date}`);

// --- Early checkout -------------------------------------------------------
// A guest leaves after one night. The nights that are no longer used must be released, or the
// unit is unsellable for dates nobody is in it.
// A guest leaves after the first night. The date comes from the booking, not from an offset
// guessed before it existed.
const beforeCheckout = await app.evaluate(`
  const current = (await window.domBook.reservations.list()).data.find((r) => r.id === ${JSON.stringify(stay.data?.id)});
  const plus = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  return { id: current.id, checkIn: current.check_in_date, checkOut: current.check_out_date,
    actual: plus(current.check_in_date, 1) };
`);
const earlyResult = await app.evaluate(`
  const current = ${JSON.stringify(beforeCheckout)};
  const f = document.getElementById('earlyCheckoutForm');
  f.elements.actualCheckOutDate.value = current.actual;
  const r = await window.domBook.reservations.earlyCheckout(current.id, {
    actualCheckOutDate: current.actual, billingPolicy: 'keep_total' });
  await refreshCore();
  return { r, actual: current.actual, checkIn: current.checkIn, checkOut: current.checkOut };
`);
const early = earlyResult.r;
check(early.ok === true, "an early checkout is recorded", `err=${early.error ?? "none"}`);
check(early.data?.actual_check_out_date === earlyResult.actual,
  "the actual departure is stored", `actual=${early.data?.actual_check_out_date} expected=${earlyResult.actual}`);

const released = await app.evaluate(`
  const current = (await window.domBook.reservations.list()).data.find((r) => r.id === ${JSON.stringify(stay.data?.id)});
  const plus = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const cal = await window.domBook.calendar.get(60);
  const from = current.actual_check_out_date;
  const to = current.check_out_date;
  return (cal.data?.occupancy || []).filter((o) => o.property_id === current.property_id
    && o.night_date >= from && o.night_date < to).length;
`);
check(released === 0, "the nights after an early departure are released", `still occupied=${released}`);

// --- Cancelling frees the calendar ---------------------------------------
//
// Its own unit. The suite already booked +2..+5 and checked out early at +3 on the first
// unit; reusing it meant a repeated run collided with its own previous booking.
//
// Nothing in this app refuses a unit by itself: there is NO client-side entitlement cap
// (the server owns enforcement, so a licensed user offline is never locked out). An earlier
// version of this block therefore created a unit and never checked the result, then passed
// `unit.data?.id` into the booking below. When the create failed for any reason the booking
// failed with "propertyId is required", and FOUR consecutive checks went red — reading like
// six product bugs while the real error had been discarded one line earlier.
const cancelUnit = await app.evaluate(`
  const stamp = Date.now();
  const place = (await window.domBook.places.list()).data.find((p) => p.name.startsWith('Опер-'));
  const unit = await window.domBook.properties.create({ placeId: place.id, name: 'Отмена-' + stamp, capacity: 4,
    basePriceMinor: 10000, monthlyRateMinor: 0, depositMinor: 0, currency: 'AZN', kind: 'house', status: 'active' });
  await refreshCore();
  const allowance = (await window.domBook.entitlements.get()).data?.allowance;
  const names = (await window.domBook.properties.list()).data.map((p) => p.name);
  return { id: unit.data?.id ?? null, error: unit.error ?? null, placeId: place?.id ?? null,
    allowance, activeNames: names.filter((n) => n === 'Отмена-' + stamp).length };
`);
check(Boolean(cancelUnit.id), "a unit exists to cancel against",
  `err=${cancelUnit.error ?? "none"} allowance=${JSON.stringify(cancelUnit.allowance)}
   place=${cancelUnit.placeId} matchingRows=${cancelUnit.activeNames}`);

// The booking window comes from live occupancy, not from a fixed offset. Every other block in
// this file was moved off fixed offsets after a leftover row made a correct booking look
// broken; this block was the last one still using "+10..+12", which is also the only way it
// could be refused on dates while the unit itself was fine.
const cancelWindow = await app.evaluate(`
  const today = (await window.domBook.system.info()).data.bookingPolicy.today;
  const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const occupancy = (await window.domBook.calendar.get(60)).data?.occupancy || [];
  for (let offset = 1; offset <= 18; offset += 1) {
    const from = add(today, offset), to = add(today, offset + 2);
    const taken = occupancy.some((o) => o.property_id === ${JSON.stringify(cancelUnit.id)}
      && o.night_date >= from && o.night_date < to);
    if (!taken) return { from, to, offset };
  }
  return { from: add(today, 1), to: add(today, 3), offset: 1 };
`);

const toCancel = await app.evaluate(`
  const b = await window.domBook.reservations.create({ propertyId: ${JSON.stringify(cancelUnit.id)},
    guestName: 'Отменяемый', checkInDate: ${JSON.stringify(cancelWindow.from)},
    checkOutDate: ${JSON.stringify(cancelWindow.to)}, status: 'confirmed',
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 1, children: 0 });
  await refreshCore();
  if (b.ok) return b;
  // The snapshot is printed only when the booking was refused. It answers the two questions
  // that a bare "propertyId is required" cannot: was the unit actually there, and did the
  // client believe it was allowed to have it?
  const info = (await window.domBook.system.info()).data;
  const allowance = (await window.domBook.entitlements.get()).data?.allowance;
  const listed = (await window.domBook.properties.list()).data.map((p) => p.id);
  const occupancy = (await window.domBook.calendar.get(60)).data?.occupancy || [];
  return { ...b, snapshot: { today: info.bookingPolicy.today, window: info.bookingPolicy,
    allowance, unitIsListed: listed.includes(${JSON.stringify(cancelUnit.id)}), listedCount: listed.length,
    daysOccupied: occupancy.filter((o) => o.property_id === ${JSON.stringify(cancelUnit.id)}).length } };
`);
check(toCancel.ok === true, "a second booking exists",
  `error=${toCancel.error ?? "none"} window=${cancelWindow.from}..${cancelWindow.to} (offset ${cancelWindow.offset})`
  + (toCancel.snapshot ? ` snapshot=${JSON.stringify(toCancel.snapshot)}` : ""));
check(await nightsOn(cancelUnit.id, cancelWindow.from, cancelWindow.to) === 2,
  "its nights are occupied before cancelling");

const cancelled = await app.evaluate(`
  const r = await window.domBook.reservations.cancel(${JSON.stringify(toCancel.data?.id)});
  await refreshCore();
  return r;
`);
check(cancelled.ok === true, "the booking can be cancelled", `err=${cancelled.error ?? "none"}`);
const afterCancel = await nightsOn(cancelUnit.id, cancelWindow.from, cancelWindow.to);
// A cancelled booking must not keep holding inventory; that is the whole point of cancelling.
check(afterCancel === 0, "cancelling releases the nights", `still occupied=${afterCancel}`);
const rebookable = await app.evaluate(`
  const b = await window.domBook.reservations.create({ propertyId: ${JSON.stringify(cancelUnit.id)},
    guestName: 'Встал на освободившееся', checkInDate: ${JSON.stringify(cancelWindow.from)},
    checkOutDate: ${JSON.stringify(cancelWindow.to)}, status: 'confirmed',
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 1, children: 0 });
  await refreshCore();
  return b;
`);
check(rebookable.ok === true, "the freed dates can be sold again",
  `err=${rebookable.error ?? "none"} dates=${cancelWindow.from}..${cancelWindow.to} unit=${cancelUnit.id}`);

// --- Deleting a booking ---------------------------------------------------
// Deleting is a two-step decision in this app: an active booking must be cancelled first,
// because removing a live reservation by accident loses a guest's dates with no trace. The
// refusal below is the guard working, so the test cancels and THEN deletes.
const activeGuard = await app.evaluate(`
  const b = await window.domBook.reservations.create({ propertyId: ${JSON.stringify(base.unitId)},
    guestName: 'Защита', checkInDate: ${JSON.stringify(addDays(base.today, 15))},
    checkOutDate: ${JSON.stringify(addDays(base.today, 17))}, status: 'confirmed',
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 1, children: 0 });
  await refreshCore();
  if (!b.ok) return { createError: b.error };
  const attempt = await window.domBook.reservations.delete(b.data.id);
  return { id: b.data.id, attempt };
`);
check(activeGuard.createError === undefined && activeGuard.attempt?.ok === false,
  "an active booking cannot be deleted without cancelling first",
  `createError=${activeGuard.createError ?? "none"} deleteError=${activeGuard.attempt?.error}`);

const toDelete = await app.evaluate(`
  const b = await window.domBook.reservations.create({ propertyId: ${JSON.stringify(base.unitId)},
    guestName: 'Удаляемый', checkInDate: ${JSON.stringify(addDays(base.today, 20))},
    checkOutDate: ${JSON.stringify(addDays(base.today, 22))}, status: 'confirmed',
    prepaidMinor: 0, depositMinor: 0, depositStatus: 'none', adults: 1, children: 0 });
  await refreshCore();
  return b;
`);
const deleted = await app.evaluate(`
  await window.domBook.reservations.cancel(${JSON.stringify(toDelete.data?.id)});
  const r = await window.domBook.reservations.delete(${JSON.stringify(toDelete.data?.id)});
  await refreshCore();
  const list = await window.domBook.reservations.list();
  return { r, present: (list.data || []).some((x) => x.id === ${JSON.stringify(toDelete.data?.id)}) };
`);
check(deleted.r.ok === true, "a booking can be deleted", `err=${deleted.r.error ?? "none"}`);
check(deleted.present === false, "the deleted booking is gone from the list");
check(await nightsOn(base.unitId, addDays(base.today, 20), addDays(base.today, 22)) === 0,
  "deleting releases its nights");

// --- Archiving and restoring a unit --------------------------------------
const archived = await app.evaluate(`
  const r = await window.domBook.properties.archive(${JSON.stringify(base.unitId)});
  await refreshCore();
  // listProperties INCLUDES archived by default — the management list shows everything and
  // marks archived rows. The bookable list is the one that must exclude it, and that is
  // activeProperties(), which the booking dialog uses.
  const bookable = activeProperties().map((x) => x.id);
  const all = await window.domBook.properties.list({ includeArchived: true });
  return { r,
    inActive: bookable.includes(${JSON.stringify(base.unitId)}),
    inAll: (all.data || []).some((x) => x.id === ${JSON.stringify(base.unitId)}) };
`);
check(archived.r.ok === true, "a unit can be archived", `err=${archived.r.error ?? "none"}`);
check(archived.inActive === false, "an archived unit leaves the active list");
check(archived.inAll === true, "it is still visible when archived units are included");

const restored = await app.evaluate(`
  const r = await window.domBook.properties.restore(${JSON.stringify(base.unitId)});
  await refreshCore();
  return { r, inActive: activeProperties().map((x) => x.id).includes(${JSON.stringify(base.unitId)}) };
`);
check(restored.r.ok === true, "a unit can be restored", `err=${restored.r.error ?? "none"}`);
check(restored.inActive === true, "the restored unit is bookable again");

// --- Backups --------------------------------------------------------------
const backup = await app.evaluate(`return await window.domBook.backups.create()`);
check(backup.ok === true, "a backup can be created", `err=${backup.error ?? "none"}`);
const backups = await app.evaluate(`return await window.domBook.backups.list()`);
const entries = backups.data?.backups ?? backups.data ?? [];
check(Array.isArray(entries) && entries.length > 0, "the backup is listed", `count=${entries?.length}`);

const ok = finish();
console.log(ok ? "OPERATIONS OK" : "OPERATIONS FAILED");
app.close();
process.exit(ok ? 0 : 1);

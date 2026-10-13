"use strict";

// Long-term rentals in the desktop data layer.
//
// These exercise the layer the UI calls, so a screen that works is a screen whose backing
// calls work. Two of the failure modes they exist to catch are silent ones: rent computed as
// nights x nightly rate (a plausible-looking number that is not a year's rent), and a let
// priced at zero because its month count came out as zero.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RentKeeperDatabase } = require("../src/database.cjs");

async function freshDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-rentals-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new RentKeeperDatabase({ filePath: path.join(dir, "dombook.sqlite"), backupDir: dir, seed: false });
  await db.init();
  return db;
}

/** Add whole calendar months, clamping to the target month's last day. */
function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The account's own "today", which is what a real booking is judged against. */
const todayOf = (db) => db.systemInfo().bookingPolicy.today;

function seedPlace(db) {
  return db.createPlace({ name: "Дом", address: "", hasFoodService: false });
}

function unit(db, place, overrides = {}) {
  return db.createProperty({
    placeId: place.id, name: "Объект", capacity: 2, basePriceMinor: 5000,
    monthlyRateMinor: 0, depositMinor: 0, currency: "AZN", kind: "house",
    status: "active", ...overrides,
  });
}

test("a unit can be given a monthly rate", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });

  assert.equal(flat.monthly_rate_minor, 60000, "the monthly rate must be stored, not dropped");
  // And it survives a reload, so the Rentals screen can offer it after a restart.
  assert.equal(db.getProperty(flat.id).monthly_rate_minor, 60000);
});

test("a tenancy is priced by the month, not by the night", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", basePriceMinor: 5000, monthlyRateMinor: 60000 });
  const today = todayOf(db);

  const rental = db.createReservation({
    propertyId: flat.id, guestName: "Арендатор",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 12),
    bookingKind: "rental", status: "confirmed",
    prepaidMinor: 0, depositMinor: 60000, depositStatus: "received",
    adults: 2, children: 0,
  });

  assert.equal(rental.booking_kind, "rental");
  assert.equal(rental.monthly_rate_minor, 60000, "the rate is captured on the booking");
  assert.equal(
    rental.accommodation_minor, 720000,
    "rent is 12 x 60000; nights x the nightly rate would be 1825000",
  );
  assert.equal(rental.total_minor, 720000, "the total follows the rent");
});

test("a tenancy keeps the agreed rate when the unit's rate later changes", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const today = todayOf(db);

  const rental = db.createReservation({
    propertyId: flat.id, guestName: "Арендатор",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 6),
    bookingKind: "rental", status: "confirmed",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 2, children: 0,
  });

  // A price rise must not reprice an existing lease. updateProperty takes the camelCase
  // input shape, not the stored row.
  db.updateProperty(flat.id, {
    placeId: flat.place_id, kind: flat.kind, name: flat.name, location: flat.location,
    capacity: flat.capacity, basePriceMinor: flat.base_price_minor, monthlyRateMinor: 90000,
    depositMinor: flat.deposit_minor, currency: flat.currency,
    checkInTime: flat.check_in_time, checkOutTime: flat.check_out_time,
    status: flat.status, notes: flat.notes,
  });
  const reloaded = db.getReservation(rental.id);
  assert.equal(reloaded.accommodation_minor, 360000, "the lease keeps the rate it was signed at");
});

test("a tenancy shorter than a month is refused, so rent cannot come out as zero", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const today = todayOf(db);
  const start = addMonths(today, 3);

  assert.throws(
    () => db.createReservation({
      propertyId: flat.id, guestName: "Короткий",
      checkInDate: start, checkOutDate: addDays(start, 10),
      bookingKind: "rental", status: "confirmed",
      prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 1, children: 0,
    }),
    /короче одного календарного месяца/,
  );
});

test("a let with no rate is refused rather than priced at zero", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Без ставки", monthlyRateMinor: 0 });
  const today = todayOf(db);

  assert.throws(
    () => db.createReservation({
      propertyId: flat.id, guestName: "Без ставки",
      checkInDate: addMonths(today, 5), checkOutDate: addMonths(addMonths(today, 5), 3),
      bookingKind: "rental", status: "confirmed",
      prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 1, children: 0,
    }),
    /месячную ставку/,
  );
});

test("a negotiated amount overrides the unit's rate, and makes a rate unnecessary", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  // No monthly rate at all: the price was agreed per deal.
  const flat = unit(db, place, { name: "Договорной", monthlyRateMinor: 0 });
  const today = todayOf(db);

  const negotiated = db.createReservation({
    propertyId: flat.id, guestName: "Договорная",
    checkInDate: addMonths(today, 6), checkOutDate: addMonths(addMonths(today, 6), 6),
    bookingKind: "rental", status: "confirmed", accommodationMinor: 300000,
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 1, children: 0,
  });

  assert.equal(negotiated.accommodation_minor, 300000, "the negotiated figure wins");
});

test("a tenancy is exempt from the advance window but a stay is not", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const today = todayOf(db);

  // A year out: impossible for a stay, ordinary for a lease.
  assert.doesNotThrow(() => db.createReservation({
    propertyId: flat.id, guestName: "Арендатор",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 12),
    bookingKind: "rental", status: "confirmed",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 2, children: 0,
  }));

  const cottage = unit(db, place, { name: "Коттедж", kind: "cottage" });
  assert.throws(
    () => db.createReservation({
      propertyId: cottage.id, guestName: "Гость",
      checkInDate: addMonths(today, 13), checkOutDate: addMonths(today, 14),
      status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none",
      adults: 1, children: 0,
    }),
    /день вперёд/,
    "the exemption must be narrow",
  );
});

test("an ordinary stay is unaffected: priced by the night, kind stay", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const cottage = unit(db, place, { name: "Коттедж", basePriceMinor: 20000, kind: "cottage" });
  const today = todayOf(db);

  const stay = db.createReservation({
    propertyId: cottage.id, guestName: "Гость",
    checkInDate: addDays(today, 5), checkOutDate: addDays(today, 8),
    status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none",
    adults: 2, children: 0,
  });

  assert.equal(stay.booking_kind, "stay");
  assert.equal(stay.accommodation_minor, 60000, "3 nights x 20000");
});

test("meter readings are stored, and a malformed value does not lose the booking", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const today = todayOf(db);

  const withReadings = db.createReservation({
    propertyId: flat.id, guestName: "С показаниями",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 6),
    bookingKind: "rental", status: "confirmed",
    meterReadings: { electricity: { start: 1200, end: 1340 } },
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 1, children: 0,
  });
  assert.equal(
    withReadings.meter_readings,
    JSON.stringify({ electricity: { start: 1200, end: 1340 } }),
    "the readings are stored as JSON",
  );

  // Readings are reference data. A bad value must not cost the booking.
  const other = unit(db, place, { name: "Квартира 2", monthlyRateMinor: 60000 });
  const withBadReadings = db.createReservation({
    propertyId: other.id, guestName: "С плохими показаниями",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 6),
    bookingKind: "rental", status: "confirmed", meterReadings: "not json",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 1, children: 0,
  });
  assert.equal(withBadReadings.meter_readings, "{}", "an unreadable value degrades to empty");
});

test("rentals are distinguishable from stays in the list the UI reads", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const cottage = unit(db, place, { name: "Коттедж", kind: "cottage" });
  const today = todayOf(db);

  db.createReservation({
    propertyId: flat.id, guestName: "Арендатор",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 12),
    bookingKind: "rental", status: "confirmed",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 2, children: 0,
  });
  db.createReservation({
    propertyId: cottage.id, guestName: "Гость",
    checkInDate: addDays(today, 5), checkOutDate: addDays(today, 8),
    status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none",
    adults: 2, children: 0,
  });

  const all = db.listReservations();
  const rentals = all.filter((r) => r.booking_kind === "rental");
  assert.equal(rentals.length, 1, "exactly the tenancy is a rental");
  assert.equal(all.filter((r) => r.booking_kind !== "rental").length, 1, "the stay is not");
});


test("a tenancy's nights are queued for sync, not just the booking", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const today = todayOf(db);

  const rental = db.createReservation({
    propertyId: flat.id, guestName: "Арендатор",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 3),
    bookingKind: "rental", status: "confirmed",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 2, children: 0,
  });

  const nights = db.query(
    "SELECT COUNT(*) AS n FROM reservation_nights WHERE reservation_id = ?",
    [rental.id],
  )[0].n;
  assert.ok(nights > 80, `the lease should occupy ~3 months of nights, got ${nights}`);

  // `reservation_nights` is a synced table. Queueing only the reservation sent the booking
  // without its nights, so a second device held a tenancy that blocked nothing and showed the
  // unit as free for the whole term — a double-booking waiting to happen.
  const queued = db.query(
    `SELECT COUNT(*) AS n FROM sync_outbox
      WHERE table_name = 'reservation_nights'
        AND row_id IN (SELECT id FROM reservation_nights WHERE reservation_id = ?)`,
    [rental.id],
  )[0].n;
  assert.equal(queued, nights, "every night of the tenancy must be queued for sync");
});

test("an ordinary stay also queues its nights", async (t) => {
  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const cottage = unit(db, place, { name: "Коттедж", basePriceMinor: 20000, kind: "cottage" });
  const today = todayOf(db);

  const stay = db.createReservation({
    propertyId: cottage.id, guestName: "Гость",
    checkInDate: addDays(today, 5), checkOutDate: addDays(today, 8),
    status: "confirmed", prepaidMinor: 0, depositMinor: 0, depositStatus: "none",
    adults: 2, children: 0,
  });

  const queued = db.query(
    `SELECT COUNT(*) AS n FROM sync_outbox
      WHERE table_name = 'reservation_nights'
        AND row_id IN (SELECT id FROM reservation_nights WHERE reservation_id = ?)`,
    [stay.id],
  )[0].n;
  assert.equal(queued, 3, "a 3-night stay must queue 3 nights");
});


// --- push payload ordering and column types ---------------------------------
//
// Both of these were found by pushing a real lease to the server: the sync failed with
// "unable to encode 0 into binary format for bool" and then with a foreign key violation. A
// unit suite that never speaks to the server cannot see either.

const { toRemote } = require("../src/main/sync.cjs");

test("a boolean column is sent as a boolean, not as SQLite's 0/1", async (t) => {
  // SQLite has no boolean type, so has_food_service is an integer locally. The server's column
  // is a real boolean and pgx encodes a Go int as int8: the parameter cannot be converted, the
  // whole batch is refused, and the outbox never drains. A numeric cast in SQL does not help,
  // because the failure happens while encoding, before the cast.
  const remote = toRemote("places", { id: "p1", name: "Дом", has_food_service: 1 });
  assert.equal(remote.has_food_service, true, "1 must become true");
  assert.equal(toRemote("places", { id: "p1", name: "Дом", has_food_service: 0 }).has_food_service, false,
    "0 must become false");
});

test("the push payload is ordered so a booking precedes its child rows", async (t) => {
  const { createSyncEngine, TABLE_MAP } = require("../src/main/sync.cjs");
  assert.ok(TABLE_MAP, "TABLE_MAP is exported");

  const db = await freshDatabase(t);
  const place = seedPlace(db);
  const flat = unit(db, place, { name: "Квартира", monthlyRateMinor: 60000 });
  const today = todayOf(db);
  db.createReservation({
    propertyId: flat.id, guestName: "Арендатор",
    checkInDate: addMonths(today, 1), checkOutDate: addMonths(addMonths(today, 1), 3),
    bookingKind: "rental", status: "confirmed",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 2, children: 0,
  });

  let sentOrder = null;
  const engine = createSyncEngine({
    db,
    transport: {
      async push(payload) {
        sentOrder = Object.keys(payload.changes);
        return { applied: 0, stale: 0, conflicts: 0, rejected: 0, results: [], state: { version: 1 } };
      },
      async pull() { return { state: { version: 1 }, changes: {} }; },
    },
    nowIso: () => new Date().toISOString(),
    deviceId: () => "test-device",
  });
  await engine.sync();

  assert.ok(sentOrder, "a push was issued");
  const reservationAt = sentOrder.indexOf("reservations");
  const nightsAt = sentOrder.indexOf("reservation_nights");
  assert.ok(reservationAt >= 0 && nightsAt >= 0, `both tables must be sent, got ${sentOrder}`);
  assert.ok(
    reservationAt < nightsAt,
    `reservations must precede reservation_nights or the nights violate the foreign key and ` +
    `the whole batch is rolled back; got ${sentOrder}`,
  );
});

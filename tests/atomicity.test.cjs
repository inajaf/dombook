"use strict";

// A refused booking must leave NOTHING behind.
//
// A booking is written as a parent row plus one row per night. If the nights are refused and
// the parent is not rolled back, the database keeps a reservation with no nights: the calendar
// shows the dates as free, and the NEXT attempt to book them is refused with "already
// occupied" — naming a booking the user never successfully made. That state is invisible in
// the UI and impossible to clear without deleting the ghost row.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RentKeeperDatabase } = require("../src/database.cjs");

async function freshDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new RentKeeperDatabase({ filePath: path.join(dir, "dombook.sqlite"), backupDir: dir, seed: false });
  await db.init();
  return db;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test("a refused booking leaves no reservation and no nights", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Дом", address: "", hasFoodService: false });
  const unit = db.createProperty({
    placeId: place.id, name: "Коттедж", capacity: 4, basePriceMinor: 10000,
    monthlyRateMinor: 0, depositMinor: 0, currency: "AZN", kind: "house", status: "active",
  });
  const today = db.systemInfo().bookingPolicy.today;

  const payload = {
    propertyId: unit.id, guestName: "Первый", status: "hold",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 2, children: 0,
    checkInDate: addDays(today, 2), checkOutDate: addDays(today, 5),
  };

  const created = db.createReservation(payload);
  assert.ok(created?.id, "the first booking is created");
  const before = db.query("SELECT COUNT(*) AS n FROM reservation_nights")[0].n;
  assert.equal(before, 3, "the first booking occupies 3 nights");

  // The same dates again must be refused.
  assert.throws(() => db.createReservation(payload), /занят/);

  // And the refusal must not have added anything.
  assert.equal(db.query("SELECT COUNT(*) AS n FROM reservations")[0].n, 1,
    "a refused booking must not leave a reservation row behind");
  assert.equal(db.query("SELECT COUNT(*) AS n FROM reservation_nights")[0].n, before,
    "a refused booking must not leave nights behind");
});

test("a booking whose nights are refused does not poison the next attempt", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Дом", address: "", hasFoodService: false });
  const unit = db.createProperty({
    placeId: place.id, name: "Коттедж", capacity: 2, basePriceMinor: 10000,
    monthlyRateMinor: 0, depositMinor: 0, currency: "AZN", kind: "house", status: "active",
  });
  const today = db.systemInfo().bookingPolicy.today;

  db.createReservation({
    propertyId: unit.id, guestName: "Первый", status: "confirmed",
    prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 1, children: 0,
    checkInDate: addDays(today, 2), checkOutDate: addDays(today, 4),
  });

  // Someone over the capacity, on dates that also collide.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(() => db.createReservation({
      propertyId: unit.id, guestName: "Повтор", status: "hold",
      prepaidMinor: 0, depositMinor: 0, depositStatus: "none", adults: 99, children: 0,
      checkInDate: addDays(today, 2), checkOutDate: addDays(today, 4),
    }));
  }
  assert.equal(db.query("SELECT COUNT(*) AS n FROM reservations")[0].n, 1,
    "repeated refusals must not accumulate rows");
});

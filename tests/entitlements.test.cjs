"use strict";

// Entitlement tests for the desktop client.
//
// These cover the CACHED licence, which is what the client uses while offline. The server
// remains authoritative: it holds the entitlement, sees every device, and closes the race
// with a database trigger. What matters here is that the cache fails in the cautious
// direction — a device that cannot reach the server must never hand out the paid tier.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DomBookDatabase } = require("../src/database.cjs");

async function freshDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-entitlements-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DomBookDatabase({ filePath: path.join(dir, "dombook.sqlite"), backupDir: dir, seed: false });
  await db.init();
  return db;
}

// --- entitlements -----------------------------------------------------------

test("a device with no cached licence assumes the free tier", async (t) => {
  const db = await freshDatabase(t);

  // The conservative direction: a device that has never synced must not assume it is
  // licensed, or a fresh install would hand out the paid tier before the server has spoken.
  assert.equal(db.entitlements(), null);
  assert.equal(db.unitAllowance(), 1);
  assert.equal(db.unitAllowanceStatus().unlimited, false);
});

test("a cached perpetual licence lifts the cap", async (t) => {
  const db = await freshDatabase(t);

  db.setEntitlements({
    paid: true,
    planName: "Пожизненная лицензия",
    skus: ["app_perpetual"],
    unitLimit: null,
    expiresAt: null,
    features: ["paid_tier"],
  });

  const cached = db.entitlements();
  assert.equal(cached.paid, true);
  assert.equal(cached.unitLimit, null, "null means unlimited and must survive the cache");
  assert.equal(db.unitAllowance(), null, "a licensed account has no cap");
  assert.equal(db.unitAllowanceStatus().unlimited, true);
});

test("a corrupt entitlement cache does not hand out the paid tier", async (t) => {
  const db = await freshDatabase(t);

  db.upsertSetting("entitlements", "{not json");
  assert.equal(db.entitlements(), null, "an unreadable cache reads as no cache");
  assert.equal(db.unitAllowance(), 1, "and the free cap applies");

  // A cache claiming paid but omitting unitLimit must also not read as unlimited: a missing
  // field would be a giveaway, whereas falling back to the cap is merely cautious.
  db.upsertSetting("entitlements", JSON.stringify({ paid: true }));
  const parsed = db.entitlements();
  assert.equal(parsed.unitLimit, 1, "a paid cache with no limit field falls back to the cap");
});

test("an expired cached licence falls back to the free cap", async (t) => {
  const db = await freshDatabase(t);
  db.setEntitlements({ paid: false, planName: "Бесплатный", skus: [], unitLimit: 1, expiresAt: "2020-01-01T00:00:00Z", features: [] });

  assert.equal(db.unitAllowance(), 1);
  const status = db.unitAllowanceStatus();
  assert.equal(status.unlimited, false);
  assert.equal(status.allowance, 1);
});

test("over-allowance is reported rather than refused", async (t) => {
  const db = await freshDatabase(t);

  // The demo seed creates several units on the free tier. Refusing locally would make the
  // application fail to start with its own dataset — and would lock out a licensed user
  // whose cache had not yet arrived. So the client reports the state and lets the server
  // refuse, which is the only place that can decide.
  const place = db.createPlace({ name: "База", address: "", hasFoodService: false });
  db.createProperty({ placeId: place.id, name: "Первый", capacity: 4, basePriceMinor: 1000, depositMinor: 0, currency: "AZN", kind: "cottage", status: "active" });
  db.createProperty({ placeId: place.id, name: "Второй", capacity: 4, basePriceMinor: 1000, depositMinor: 0, currency: "AZN", kind: "cottage", status: "active" });

  const status = db.unitAllowanceStatus();
  assert.equal(status.active, 2, "both units were created locally");
  assert.equal(status.allowance, 1);
  assert.equal(status.over, true, "the over-allowance state is reported");
  assert.equal(status.remaining, 0, "remaining never goes negative");
});


// --- the account policy must actually reach the validator --------------------
//
// These cover the wiring rather than the rule. `booking-policy.test.cjs` proves
// `assertBookingDates` honours a policy it is given; these prove the DATABASE passes the
// account's policy in. That is a separate failure mode: the validator can be perfect and
// still never see the account's window, in which case every client silently applies the
// compiled default and an owner who widened their window is refused locally while the server
// accepts the booking.

/** A date N days after the database's notion of "today". */
function daysFromToday(db, days) {
  const today = db.systemInfo().bookingPolicy.today;
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A reservation payload with every field the validator requires. */
function booking(propertyId, checkInDate, checkOutDate) {
  return {
    propertyId,
    guestName: "Тестовый гость",
    guestPhone: "+994501112233",
    guestEmail: "guest@example.com",
    checkInDate,
    checkOutDate,
    adults: 2,
    children: 0,
    status: "confirmed",
    totalMinor: 60000,
    prepaidMinor: 20000,
    depositMinor: 30000,
    depositStatus: "due",
    notes: "",
  };
}

function seedUnit(db) {
  const place = db.createPlace({ name: "База", address: "", hasFoodService: false });
  return db.createProperty({
    placeId: place.id, name: "Коттедж", capacity: 4, basePriceMinor: 20000,
    depositMinor: 0, currency: "AZN", kind: "cottage", status: "active",
  });
}

test("a widened account policy lets the client book further ahead", async (t) => {
  const db = await freshDatabase(t);
  const unit = seedUnit(db);

  const checkIn = daysFromToday(db, 40);
  const checkOut = daysFromToday(db, 43);

  // The shipped default is 21 days, so this is refused before anything is configured.
  assert.throws(() => db.createReservation(booking(unit.id, checkIn, checkOut)),
    /21 день/, "the default window should refuse a booking 40 days out");

  // The account widens its window. This is what the server reports and the client caches.
  db.setBookingPolicy({ maximumAdvanceDays: 60, maximumStayMonths: 6, timeZone: "Asia/Baku" });

  const created = db.createReservation(booking(unit.id, checkIn, checkOut));
  assert.ok(created, "a booking inside the account's window must be accepted");
  assert.equal(created.check_in_date, checkIn);
});

test("a narrowed account policy refuses dates the default would allow", async (t) => {
  const db = await freshDatabase(t);
  const unit = seedUnit(db);

  db.setBookingPolicy({ maximumAdvanceDays: 7, maximumStayMonths: 1, timeZone: "Asia/Baku" });

  // Ten days out: inside the shipped default, outside this account's window.
  assert.throws(() => db.createReservation(booking(unit.id, daysFromToday(db, 10), daysFromToday(db, 12))),
    /7 день/, "the narrowed window should refuse a booking 10 days out");
});

test("the policy survives a restart, so an offline device keeps the right window", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "dombook.sqlite");

  const first = new DomBookDatabase({ filePath, backupDir: dir, seed: false });
  await first.init();
  first.setBookingPolicy({ maximumAdvanceDays: 90, maximumStayMonths: 12, timeZone: "UTC" });

  const second = new DomBookDatabase({ filePath, backupDir: dir, seed: false });
  await second.init();
  assert.equal(second.bookingPolicy().maximumAdvanceDays, 90, "the cached window must persist");

  // And a booking inside it is accepted after the restart, which is the point of caching it:
  // the rule still works with no server to ask.
  const unit = seedUnit(second);
  const created = second.createReservation(
    booking(unit.id, daysFromToday(second, 45), daysFromToday(second, 48)));
  assert.ok(created, "the cached window must apply offline");
});


test("a cached licence survives a restart, so an offline licensed device stays licensed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-licence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "dombook.sqlite");

  const first = new DomBookDatabase({ filePath, backupDir: dir, seed: false });
  await first.init();
  first.setEntitlements({
    paid: true, planName: "Пожизненная лицензия", skus: ["app_perpetual"],
    unitLimit: null, expiresAt: null, features: ["paid_tier"],
  });

  // Reopening without syncing: the cache has to be on disk, or a licensed customer who opens
  // the app offline is handed the free tier.
  const second = new DomBookDatabase({ filePath, backupDir: dir, seed: false });
  await second.init();
  assert.equal(second.entitlements()?.paid, true, "the licence must survive a restart");
  assert.equal(second.unitAllowance(), null, "and it must still lift the cap");
});

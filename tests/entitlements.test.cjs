"use strict";
const { entitlements } = require("../src/domain/reports.cjs");

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

const { RentKeeperDatabase } = require("../src/database.cjs");

async function freshDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-entitlements-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new RentKeeperDatabase({ filePath: path.join(dir, "dombook.sqlite"), backupDir: dir, seed: false });
  await db.init();
  return db;
}

// --- entitlements -----------------------------------------------------------

test("a device with no cached licence assumes the free tier", async (t) => {
  const db = await freshDatabase(t);

  // The conservative direction: a device that has never synced must not assume it is
  // licensed, or a fresh install would hand out the paid tier before the server has spoken.
  assert.equal(entitlements(db), null);
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

  const cached = entitlements(db);
  assert.equal(cached.paid, true);
  assert.equal(cached.unitLimit, null, "null means unlimited and must survive the cache");
  assert.equal(db.unitAllowance(), null, "a licensed account has no cap");
  assert.equal(db.unitAllowanceStatus().unlimited, true);
});

test("a corrupt entitlement cache does not hand out the paid tier", async (t) => {
  const db = await freshDatabase(t);

  db.upsertSetting("entitlements", "{not json");
  assert.equal(entitlements(db), null, "an unreadable cache reads as no cache");
  assert.equal(db.unitAllowance(), 1, "and the free cap applies");

  // A cache claiming paid but omitting unitLimit must also not read as unlimited: a missing
  // field would be a giveaway, whereas falling back to the cap is merely cautious.
  db.upsertSetting("entitlements", JSON.stringify({ paid: true }));
  const parsed = entitlements(db);
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

  const first = new RentKeeperDatabase({ filePath, backupDir: dir, seed: false });
  await first.init();
  first.setBookingPolicy({ maximumAdvanceDays: 90, maximumStayMonths: 12, timeZone: "UTC" });

  const second = new RentKeeperDatabase({ filePath, backupDir: dir, seed: false });
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

  const first = new RentKeeperDatabase({ filePath, backupDir: dir, seed: false });
  await first.init();
  first.setEntitlements({
    paid: true, planName: "Пожизненная лицензия", skus: ["app_perpetual"],
    unitLimit: null, expiresAt: null, features: ["paid_tier"],
  });

  // Reopening without syncing: the cache has to be on disk, or a licensed customer who opens
  // the app offline is handed the free tier.
  const second = new RentKeeperDatabase({ filePath, backupDir: dir, seed: false });
  await second.init();
  assert.equal(entitlements(second)?.paid, true, "the licence must survive a restart");
  assert.equal(second.unitAllowance(), null, "and it must still lift the cap");
});


// --- per-device settings must not replicate ----------------------------------
//
// `app_settings` is a synced table, so a key written through the normal path travels to every
// device on the account. A licence cache, a device identity, and a read cursor are per-device
// facts: sharing them produces wrong answers, not just noise.

/** The outbox rows for a given setting key. */
function queuedSettings(db, key) {
  return db.query(
    `SELECT o.row_id, o.table_name FROM sync_outbox o
       JOIN app_settings s ON s.id = o.row_id
      WHERE o.table_name = 'app_settings' AND s.setting_key = ?`,
    [key],
  );
}

test("the licence cache is never queued for sync", async (t) => {
  const db = await freshDatabase(t);

  db.setEntitlements({
    paid: true, planName: "Пожизненная лицензия", skus: ["app_perpetual"],
    unitLimit: null, expiresAt: null, features: ["paid_tier"],
  });

  // It IS stored locally — that is the whole point of the cache.
  assert.equal(entitlements(db)?.paid, true);

  // But it must not be sent. Syncing it would let one device's cache overwrite another's, so a
  // licensed device could inherit a stale "not paid" value and be treated as unlicensed.
  assert.equal(queuedSettings(db, "entitlements").length, 0,
    "the licence cache must stay on the device that fetched it");
});

test("the device id is never queued for sync", async (t) => {
  const db = await freshDatabase(t);

  // Every install has its own id. Replicating it would make all devices claim the same writer,
  // destroying the only record of which device made a change.
  db.upsertSetting("device_id", "some-other-device");
  assert.equal(queuedSettings(db, "device_id").length, 0);
});

test("a real account setting IS queued, so the guard is not a blanket refusal", async (t) => {
  const db = await freshDatabase(t);

  // The denylist has to be a denylist. If this method stopped queueing anything, the three
  // tests above would pass while sync silently stopped carrying settings at all.
  db.upsertSetting("booking_policy", JSON.stringify({ maximumAdvanceDays: 30 }));
  assert.equal(queuedSettings(db, "booking_policy").length, 1,
    "an account-level setting must still replicate");
});

test("a full sync leaves no per-device setting stuck in the queue", async (t) => {
  const db = await freshDatabase(t);

  // Reproduces the observed failure: fetching the licence during startup re-queued it, so a
  // sync could never drain the outbox — pending stayed at 1 forever.
  db.setEntitlements({ paid: false, planName: "Бесплатный", skus: [], unitLimit: 1, expiresAt: null, features: [] });
  db.upsertSetting("interface_language", "ru");
  db.upsertSetting("booking_policy", JSON.stringify({ maximumAdvanceDays: 21 }));

  const queuedKeys = db.query(
    `SELECT s.setting_key FROM sync_outbox o JOIN app_settings s ON s.id = o.row_id
      WHERE o.table_name = 'app_settings'`,
  ).map((r) => r.setting_key);

  assert.ok(!queuedKeys.includes("entitlements"), "the licence cache must not be queued");
  assert.ok(queuedKeys.includes("interface_language") || queuedKeys.includes("booking_policy"),
    "genuine settings should still be queued");
});

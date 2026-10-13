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

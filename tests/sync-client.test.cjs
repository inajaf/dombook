"use strict";

// Tests for the desktop sync client: the outbox and the engine that drives it.
//
// These run against a real local database (the same sql.js file the app uses), because the
// behaviours that matter — a change surviving a restart, a queue that cannot disagree with
// the data, a push that does not lose work — are properties of the two being written
// together, not of either in isolation.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DomBookDatabase } = require("../src/database.cjs");
const outbox = require("../src/main/outbox.cjs");
const { createSyncEngine, shouldAdopt, toLocal, toRemote } = require("../src/main/sync.cjs");

/** A throwaway database directory, removed when the test finishes. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dombook-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freshDatabase(t, options = {}) {
  const dir = tempDir(t);
  const db = new DobBookDatabaseShim({
    filePath: path.join(dir, "dombook.sqlite"),
    backupDir: path.join(dir, "backups"),
    seed: false,
    ...options,
  });
  await db.init();
  return db;
}

// The database class is constructed directly rather than through a factory; the alias
// keeps the intent obvious at each call site.
const DobBookDatabaseShim = DomBookDatabase;

/** A transport stub that records what was sent and replays a scripted pull. */
function stubTransport({ pullResponse = { state: { version: 1 }, changes: {} }, pushResponse = null, fail = null } = {}) {
  const calls = { push: [], pull: [] };
  return {
    calls,
    async push(payload) {
      calls.push.push(payload);
      if (fail) throw fail;
      return pushResponse ?? {
        applied: Object.values(payload.changes).reduce((sum, rows) => sum + rows.length, 0),
        stale: 0,
        conflicts: 0,
        rejected: 0,
        results: Object.entries(payload.changes).flatMap(([table, rows]) =>
          rows.map((row) => ({ table, id: row.id, outcome: "applied" })),
        ),
        state: { version: 2 },
      };
    },
    async pull(since) {
      calls.pull.push(since);
      return pullResponse;
    },
  };
}

function makeEngine(db, transport, overrides = {}) {
  return createSyncEngine({
    db,
    transport,
    nowIso: () => new Date().toISOString(),
    deviceId: () => "device-test",
    ...overrides,
  });
}

// --- outbox -----------------------------------------------------------------

test("a local write queues itself for sync", async (t) => {
  const db = await freshDatabase(t);

  const place = db.createPlace({ name: "Лесная долина", address: "Габала", hasFoodService: false });

  const queued = db.query("SELECT table_name, row_id FROM sync_outbox WHERE table_name = 'places'");
  assert.equal(queued.length, 1, "the place should be queued");
  assert.equal(queued[0].row_id, place.id, "the queued row should be the one that was created");
  assert.ok(db.pendingSyncCount() >= 1);
});

test("editing a row repeatedly queues it once, in its latest state", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Первое", address: "", hasFoodService: false });

  // Three edits while offline. The server merges per row, so sending the intermediate
  // states would be work it discards; collapsing keeps a long offline session cheap.
  db.updatePlace(place.id, { name: "Второе", address: "", hasFoodService: false });
  db.updatePlace(place.id, { name: "Третье", address: "", hasFoodService: false });

  const entries = db.query("SELECT table_name, row_id, payload_json FROM sync_outbox WHERE table_name = 'places'");
  assert.equal(entries.length, 1, "a row edited three times should occupy one queue entry");

  const payload = JSON.parse(entries[0].payload_json);
  assert.equal(payload.name, "Третье", "the queued payload should be the latest state, not the first");
});

test("a queued change survives the database being reopened", async (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "dombook.sqlite");

  const first = new DomBookDatabase({ filePath, backupDir: path.join(dir, "backups"), seed: false });
  await first.init();
  const place = first.createPlace({ name: "Переживший перезапуск", address: "", hasFoodService: false });
  const queuedBefore = first.pendingSyncCount();
  assert.ok(queuedBefore > 0);

  // Reopen, as the app does on every launch.
  const second = new DomBookDatabase({ filePath, backupDir: path.join(dir, "backups"), seed: false });
  await second.init();

  const entries = second.query("SELECT row_id FROM sync_outbox WHERE row_id = ?", [place.id]);
  assert.equal(entries.length, 1, "a change made offline must survive a restart, or it is lost forever");
  assert.equal(second.pendingSyncCount(), queuedBefore);
});

test("acknowledging keeps a newer change made during the push", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Первое", address: "", hasFoodService: false });

  const entry = db.query("SELECT * FROM sync_outbox WHERE row_id = ?", [place.id])[0];

  // The row is edited again while the push is in flight — a slow network makes this
  // ordinary, not exotic.
  db.updatePlace(place.id, { name: "Изменено во время отправки", address: "", hasFoodService: false });

  // The server confirms the version that was sent.
  db.acknowledgeSync([{ ...entry, sentUpdatedAt: entry.updated_at }]);

  const remaining = db.query("SELECT payload_json FROM sync_outbox WHERE row_id = ?", [place.id]);
  assert.equal(remaining.length, 1, "the edit made during the push must not be acknowledged away");
  assert.equal(JSON.parse(remaining[0].payload_json).name, "Изменено во время отправки");
});

test("an acknowledgement cannot delete a newer change with the same timestamp", async (t) => {
  const dir = tempDir(t);
  const db = new DomBookDatabase({ filePath: path.join(dir, "dombook.sqlite"), backupDir: dir, seed: false });
  await db.init();

  // A frozen clock, so both enqueues stamp an identical timestamp. This is not
  // hypothetical: the desktop clock has millisecond resolution, and two writes within one
  // tick are ordinary on a fast machine. Identity based on the timestamp alone would make
  // the two versions indistinguishable, and confirming the first would delete the second —
  // silently losing an edit made while a push was in flight.
  const frozen = () => "2026-09-01T10:00:00.000Z";
  const placeId = "11111111-2222-3333-4444-555555555555";
  const row = { id: placeId, name: "Первое", address: "", status: "active" };

  outbox.enqueue(db, "places", placeId, row, frozen);
  const first = db.query("SELECT table_name, row_id, revision, updated_at FROM sync_outbox WHERE row_id = ?", [placeId])[0];
  assert.equal(first.updated_at, "2026-09-01T10:00:00.000Z");

  // The row is edited again in the same millisecond.
  outbox.enqueue(db, "places", placeId, { ...row, name: "Второе" }, frozen);
  const second = db.query("SELECT revision, updated_at FROM sync_outbox WHERE row_id = ?", [placeId])[0];
  assert.equal(second.revision, first.revision + 1, "a re-enqueue must bump the revision");
  assert.equal(second.updated_at, first.updated_at, "the timestamps are deliberately identical");

  // The server confirms the FIRST revision, which is what was in flight.
  outbox.acknowledge(db, [{ table_name: "places", row_id: placeId, sentRevision: first.revision }]);

  const remaining = db.query("SELECT revision, payload_json FROM sync_outbox WHERE row_id = ?", [placeId]);
  assert.equal(remaining.length, 1, "the newer edit must survive an acknowledgement of the older revision");
  assert.equal(remaining[0].revision, second.revision);
  assert.equal(JSON.parse(remaining[0].payload_json).name, "Второе");
});

test("a failed attempt is recorded and the entry stays queued", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Застрявшая запись", address: "", hasFoodService: false });
  const entry = db.query("SELECT * FROM sync_outbox WHERE row_id = ?", [place.id])[0];

  db.recordSyncFailure(entry, "сервер недоступен");

  const after = db.query("SELECT attempts, last_error FROM sync_outbox WHERE row_id = ?", [place.id])[0];
  assert.equal(after.attempts, 1);
  assert.match(after.last_error, /недоступен/);
  assert.equal(db.pendingSyncCount() >= 1, true, "a failed entry must remain queued so the work is not lost");
});

test("outbox helpers ignore rows that are not syncable", async (t) => {
  const dir = tempDir(t);
  const db = new DomBookDatabase({ filePath: path.join(dir, "dombook.sqlite"), backupDir: dir, seed: false });
  await db.init();

  // audit_log is deliberately not replicated; queueing it would send rows the server has
  // no table for and fail every push.
  const queued = outbox.enqueue(
    { run: () => { throw new Error("should not write"); } },
    "audit_log",
    "some-id",
    {},
    () => new Date().toISOString(),
  );
  assert.equal(queued, false);
});

// --- field translation ------------------------------------------------------

test("local rows translate into the server's field names", () => {
  // properties is `units` on the server, and property_id is `unit_id`. The translation is
  // explicit because renaming the local tables would rewrite every query and invalidate
  // installed databases.
  const remote = toRemote("reservations", {
    id: "r1", property_id: "p1", guest_name: "Иван", check_in_date: "2026-09-01",
    version: 4, last_writer: "device", updated_at: "2026-01-01T00:00:00Z",
  });
  assert.equal(remote.unit_id, "p1", "property_id should become unit_id");
  assert.equal(remote.guest_name, "Иван");

  // Server-owned columns are not sent. Sending updated_at is what let a device with a fast
  // clock win every conflict in the first protocol.
  assert.equal(remote.version, undefined);
  assert.equal(remote.last_writer, undefined);
  assert.equal(remote.updated_at, undefined);
});

test("server rows translate into the local field names", () => {
  const local = toLocal("reservations", {
    id: "r1", unit_id: "u1", guest_name: "Иван", tenant_id: "t1",
    updated_at: "2026-01-01T00:00:00Z", version: 7,
  });
  assert.equal(local.property_id, "u1", "unit_id should become property_id");
  assert.equal(local.tenant_id, undefined, "tenant_id is the server's concern, not a local column");
  assert.equal(local.version, 7, "the server's version is kept for display and diagnostics");
});

test("adoption prefers the server's copy", () => {
  // No local row: adopt.
  assert.equal(shouldAdopt({ updated_at: "2026-01-01T00:00:00Z" }, null), true);

  // The server's row is newer: adopt.
  assert.equal(
    shouldAdopt({ updated_at: "2026-02-01T00:00:00Z" }, { updated_at: "2026-01-01T00:00:00Z" }),
    true,
  );

  // The local row is newer, which happens when this device has an unsent edit. The server
  // copy is NOT adopted: overwriting it would discard the local change before it is pushed.
  assert.equal(
    shouldAdopt({ updated_at: "2026-01-01T00:00:00Z" }, { updated_at: "2026-02-01T00:00:00Z" }),
    false,
  );

  // Identical timestamps: adopt, because the server's copy is the one every replica
  // converges on, so taking it cannot introduce divergence.
  assert.equal(
    shouldAdopt({ updated_at: "2026-01-01T00:00:00Z" }, { updated_at: "2026-01-01T00:00:00Z" }),
    true,
  );
});

// --- engine -----------------------------------------------------------------

test("sync pushes queued changes and clears them once confirmed", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Отправляемый", address: "", hasFoodService: false });

  const transport = stubTransport();
  const engine = makeEngine(db, transport);
  const result = await engine.sync();

  assert.equal(result.ok, true);
  assert.equal(transport.calls.push.length, 1, "one push should carry the batch");

  const sentTables = Object.keys(transport.calls.push[0].changes);
  assert.ok(sentTables.includes("places"), `expected places in the push, got ${sentTables}`);
  const sentPlace = transport.calls.push[0].changes.places.find((row) => row.id === place.id);
  assert.ok(sentPlace, "the created place should be in the push");
  assert.equal(sentPlace.updated_at, undefined, "the client must not send its own timestamp");

  // The server's clock decides ordering, and it stamps the row itself.

  const remaining = db.query("SELECT row_id FROM sync_outbox WHERE row_id = ?", [place.id]);
  assert.equal(remaining.length, 0, "a confirmed change should leave the queue");
});

test("sync applies pulled changes to the local database", async (t) => {
  const db = await freshDatabase(t);

  const transport = stubTransport({
    pullResponse: {
      state: { version: 42 },
      changes: {
        units: [{
          id: "11111111-1111-1111-1111-111111111111",
          place_id: null,
          kind: "house",
          name: "Дом с сервера",
          location: "",
          capacity: 4,
          base_price_minor: 20000,
          deposit_minor: 0,
          currency: "AZN",
          check_in_time: "15:00",
          check_out_time: "11:00",
          status: "active",
          notes: "",
          created_at: "2026-09-01T00:00:00.000000Z",
          updated_at: "2026-09-01T00:00:00.000000Z",
          deleted_at: null,
        }],
      },
    },
  });

  const engine = makeEngine(db, transport);
  const result = await engine.sync();
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1, "the pulled unit should be stored");

  const stored = db.query("SELECT * FROM properties WHERE id = ?", ["11111111-1111-1111-1111-111111111111"]);
  assert.equal(stored.length, 1, "the server's unit should exist locally as a property");
  assert.equal(stored[0].name, "Дом с сервера");
});

test("the cursor only advances after the changes are stored", async (t) => {
  const db = await freshDatabase(t);
  const transport = stubTransport({ pullResponse: { state: { version: 99 }, changes: {} } });

  const engine = makeEngine(db, transport);
  assert.equal(engine.readWatermark(), 0);

  await engine.sync();
  assert.equal(engine.readWatermark(), 99, "the cursor should follow a completed pull");

  // A later pull asks for changes after that cursor, so already-seen rows are not resent.
  await engine.sync();
  assert.deepEqual(transport.calls.pull, [0, 99]);
});

test("a failed sync keeps every queued change", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Не отправленный", address: "", hasFoodService: false });
  const before = db.pendingSyncCount();

  const transport = stubTransport({ fail: new Error("сеть недоступна") });
  const engine = makeEngine(db, transport);
  const result = await engine.sync();

  assert.equal(result.ok, false, "a network failure must be reported");
  assert.match(result.error, /недоступна/);
  assert.equal(db.pendingSyncCount(), before, "a failed sync must not drop queued work");

  // And the queued row is still the one that was made.
  const still = db.query("SELECT row_id FROM sync_outbox WHERE row_id = ?", [place.id]);
  assert.equal(still.length, 1);
});

test("a row the server refuses stays queued with a reason", async (t) => {
  const db = await freshDatabase(t);
  const place = db.createPlace({ name: "Отклонённый", address: "", hasFoodService: false });

  // The server accepts nothing from this batch.
  const transport = stubTransport({
    pushResponse: { applied: 0, stale: 0, conflicts: 0, rejected: 1, results: [{ table: "units", id: "other", outcome: "rejected", reason: "missing_required_columns" }], state: { version: 3 } },
  });
  const engine = makeEngine(db, transport);
  await engine.sync();

  const entry = db.query("SELECT attempts, last_error FROM sync_outbox WHERE row_id = ?", [place.id])[0];
  assert.ok(entry, "an unconfirmed row must stay queued");
  assert.equal(entry.attempts, 1);
  assert.match(entry.last_error, /не подтвердил/);
});

test("pulled rows do not bounce back to the server", async (t) => {
  const db = await freshDatabase(t);
  const unitId = "22222222-2222-2222-2222-222222222222";

  const transport = stubTransport({
    pullResponse: {
      state: { version: 5 },
      changes: { units: [{ id: unitId, name: "С сервера", capacity: 2, base_price_minor: 0, deposit_minor: 0, currency: "AZN", check_in_time: "15:00", check_out_time: "11:00", status: "active", notes: "", created_at: "2026-09-01T00:00:00.000000Z", updated_at: "2026-09-01T00:00:00.000000Z", deleted_at: null, place_id: null, kind: "house", location: "" }] },
    },
  });

  const engine = makeEngine(db, transport);
  await engine.sync();

  // A row that came from the server is already there, so queueing it would push it
  // straight back and make the next pull look like a local change.
  const queued = db.query("SELECT row_id FROM sync_outbox WHERE row_id = ?", [unitId]);
  assert.equal(queued.length, 0, "a row received from the server must not be queued for sending");
});

test("concurrent sync attempts do not double-push", async (t) => {
  const db = await freshDatabase(t);
  db.createPlace({ name: "Параллельная", address: "", hasFoodService: false });

  let resolvePush;
  const gate = new Promise((resolve) => { resolvePush = resolve; });
  const transport = {
    calls: { push: [], pull: [] },
    async push(payload) {
      this.calls.push.push(payload);
      await gate;
      return { applied: 1, stale: 0, conflicts: 0, rejected: 0, results: [{ table: "places", id: payload.changes.places?.[0]?.id, outcome: "applied" }], state: { version: 1 } };
    },
    async pull(since) {
      this.calls.pull.push(since);
      return { state: { version: 1 }, changes: {} };
    },
  };

  const engine = makeEngine(db, transport);
  const first = engine.sync();
  // A second attempt while the first is in flight must not start a parallel push: two
  // pushes of the same rows would race, and the loser's changes could be dropped.
  const second = await engine.sync();
  assert.equal(second.skipped, true, "a concurrent sync should be skipped rather than run twice");

  resolvePush();
  await first;
  assert.equal(transport.calls.push.length, 1, "only one push should have been issued");
});

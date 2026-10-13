"use strict";

// Sync outbox: the durable record of local changes that have not reached the server.
//
// This is the piece that makes local-first safe. Without it, a change made while offline
// exists only in the local database, and the sync engine has no way to know it needs
// sending — so it never is. The user believes their booking is saved; the server never
// hears about it; a second device never sees it.
//
// Design decisions worth stating:
//
//   - An entry is written in the SAME transaction as the row it describes. A queue that
//     can disagree with the data is worse than no queue: it either resends a change that
//     was rolled back, or loses one that was committed.
//
//   - Entries are keyed by (table, row_id) and REPLACED, not appended. The server's merge
//     is last-write-wins per row, so a queue holding the intermediate states of a row
//     sends work the server will discard. Collapsing to the latest state means a row
//     edited twenty times offline costs one push, not twenty.
//
//   - Nothing is deleted until the server confirms it. A push that fails, times out, or is
//     interrupted leaves the entry in place and the next attempt resends it. The server
//     treats a repeated identical row as a no-op, so resending is free.

const SYNCABLE_TABLES = [
  "places",
  "properties",
  "reservations",
  "reservation_nights",
  "reservation_services",
  "reservation_meals",
  "app_settings",
];

const OUTBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_outbox (
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    operation TEXT NOT NULL DEFAULT 'upsert' CHECK(operation IN ('upsert', 'delete')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Monotonic per-entry revision, incremented on every enqueue.
    --
    -- This exists because a timestamp cannot identify a version. Two writes within the
    -- same millisecond produce identical updated_at values, so acknowledging the older
    -- one would delete the newer change — silently losing an edit made while a push was
    -- in flight. The revision is unambiguous.
    revision INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (table_name, row_id)
  );
  CREATE INDEX IF NOT EXISTS sync_outbox_updated_idx ON sync_outbox(updated_at);
`;

/**
 * Install the outbox table. Safe to call on every startup: the schema uses IF NOT EXISTS.
 */
function installOutbox(db) {
  db.run(OUTBOX_SCHEMA);
}

/**
 * Record a row's current state as needing to be pushed.
 *
 * `payload` must be the full row as stored, not a partial patch: the server merges per
 * column, and a partial payload would silently leave the server holding stale values for
 * the columns it omits.
 */
function enqueue(db, tableName, rowId, payload, nowIso) {
  if (!SYNCABLE_TABLES.includes(tableName)) return false;
  if (!rowId) return false;

  const timestamp = nowIso();
  const operation = payload && payload.deleted_at ? "delete" : "upsert";

  // REPLACE so a row edited repeatedly offline is sent once, in its final state. The
  // attempt counter resets because this is genuinely new work, not a retry of the old.
  db.run(
    `INSERT INTO sync_outbox(table_name, row_id, operation, payload_json, created_at, updated_at, revision, attempts, last_error)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, '')
     ON CONFLICT(table_name, row_id) DO UPDATE SET
       operation = excluded.operation,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at,
       revision = sync_outbox.revision + 1,
       attempts = 0,
       last_error = ''`,
    [tableName, rowId, operation, JSON.stringify(payload ?? {}), timestamp, timestamp],
  );
  return true;
}

/** Pending entries, oldest first, so changes are sent roughly in the order they were made. */
function pending(db, limit = 500) {
  return db.query(
    `SELECT table_name, row_id, operation, payload_json, created_at, updated_at, revision, attempts, last_error
     FROM sync_outbox ORDER BY updated_at, table_name, row_id LIMIT ?`,
    [limit],
  );
}

/** How many changes are waiting. Drives the "unsynced" indicator in the UI. */
function pendingCount(db) {
  return db.scalar("SELECT COUNT(*) FROM sync_outbox");
}

/**
 * Drop entries the server has confirmed.
 *
 * Entries are removed by primary key AND by the revision that was sent. If the row was
 * edited again while the push was in flight, the newer entry survives — deleting it would
 * lose that change permanently, which is the exact failure the outbox exists to prevent.
 *
 * The revision is used rather than the timestamp because a timestamp cannot identify a
 * version: two writes in the same millisecond share one, and acknowledging the older would
 * have deleted the newer edit.
 */
function acknowledge(db, entries) {
  let removed = 0;
  for (const entry of entries) {
    const result = db.run(
      `DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ? AND revision = ?`,
      [entry.table_name, entry.row_id, entry.sentRevision ?? entry.revision],
    );
    if (result && typeof result.changes === "number") removed += result.changes;
  }
  return removed;
}

/** Record a failed attempt so the UI can explain why a change is stuck. */
function recordFailure(db, entry, message, nowIso) {
  db.run(
    `UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?
     WHERE table_name = ? AND row_id = ? AND revision = ?`,
    [String(message ?? "").slice(0, 500), entry.table_name, entry.row_id, entry.sentRevision ?? entry.revision],
  );
}

/** Everything waiting, for diagnostics. */
function failed(db, limit = 50) {
  return db.query(
    `SELECT table_name, row_id, attempts, last_error FROM sync_outbox
     WHERE last_error <> '' ORDER BY updated_at LIMIT ?`,
    [limit],
  );
}

module.exports = {
  OUTBOX_SCHEMA,
  SYNCABLE_TABLES,
  acknowledge,
  enqueue,
  failed,
  installOutbox,
  pending,
  pendingCount,
  recordFailure,
};

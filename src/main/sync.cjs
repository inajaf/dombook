"use strict";

// Sync engine: moves changes between the desktop's local SQLite database and the server.
//
// The desktop is local-first. Every read and write happens against the local database, so
// the application never blocks on the network and works with no connection at all. This
// module is the only part that talks to the server, and it is deliberately the only part
// that can fail without the user losing work.
//
// The server is the canonical store for merge purposes: it stamps rows with its own clock
// and its watermark is a monotonic counter. The client therefore never decides who wins —
// it sends what it has and adopts what comes back.
//
// Field naming differs between the two sides, and the translation is explicit rather than
// inferred. `properties` locally is `units` on the server, and `property_id` is `unit_id`.
// Renaming the local tables would avoid that, but it would also rewrite every query in
// database.cjs and invalidate existing installed databases — a large, risky change to make
// for a naming preference. The mapping is confined to this file, where it is visible and
// tested.

const { acknowledge, enqueue, pending, pendingCount, recordFailure } = require("./outbox.cjs");

/** Tables that participate in sync, and how their names translate. */
const TABLE_MAP = {
  places: { remote: "places", local: "places" },
  properties: { remote: "units", local: "properties" },
  reservations: { remote: "reservations", local: "reservations" },
  reservation_nights: { remote: "reservation_nights", local: "reservation_nights" },
  reservation_services: { remote: "reservation_services", local: "reservation_services" },
  reservation_meals: { remote: "reservation_meals", local: "reservation_meals" },
  app_settings: { remote: "app_settings", local: "app_settings" },
};

/**
 * Columns whose names differ between the two sides, as { local: remote }.
 *
 * The desktop calls a bookable unit a `property` and refers to it as `property_id`; the
 * server calls it a `unit` and refers to it as `unit_id`. `place_id` is NOT in this map:
 * both sides use that name for the same thing — the guest house a unit belongs to.
 *
 * Getting this direction wrong is silent and destructive: a reservation would be pushed
 * with a `property_id` the server does not know, and land as a booking against nothing.
 */
const COLUMN_MAP = {
  reservations: { property_id: "unit_id" },
  reservation_nights: { property_id: "unit_id" },
};

/**
 * Columns that are BOOLEAN on the server but 0/1 integers in the local SQLite schema.
 *
 * SQLite has no boolean type, so `has_food_service` is stored as an integer. The server's
 * column is a real boolean and pgx encodes a Go int as int8, which cannot be converted to
 * bool — the push fails with "unable to encode 0 into binary format for bool", the whole
 * batch is rejected, and the outbox never drains. A numeric cast in SQL does not help,
 * because the failure happens while ENCODING the parameter, before the cast.
 */
const BOOLEAN_COLUMNS = {
  places: ["has_food_service"],
};

/**
 * The order tables must be pushed in.
 *
 * It mirrors `SyncTables` in the server's `internal/store/sync_tables.go`, and it matters:
 * a reservation must exist before its nights, or the nights violate the foreign key and the
 * ENTIRE batch is rolled back. Relying on JavaScript object key order made this
 * intermittent — a lease created after a place happened to be sent in a safe order, while one
 * created when only nights and bookings were queued sent the nights first and failed with
 * `reservation_nights_reservation_id_fkey`.
 */
const SYNC_ORDER = [
  "places",
  "units",
  "reservations",
  "reservation_nights",
  "reservation_services",
  "reservation_meals",
  "app_settings",
];

/** Columns the server owns and the client must not send or overwrite. */
const SERVER_OWNED = new Set(["tenant_id", "version", "last_writer", "updated_at", "conflict_code", "conflict_details", "resolved_at"]);

/**
 * Translate a local row into the server's shape.
 *
 * `updated_at` is deliberately not sent: the server stamps its own. Sending the device's
 * clock is what let a fast clock win every conflict in the first protocol.
 */
function toRemote(tableName, row) {
  const mapping = COLUMN_MAP[tableName] ?? {};
  const booleans = BOOLEAN_COLUMNS[tableName] ?? [];
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (SERVER_OWNED.has(key)) continue;
    const remote = mapping[key] ?? key;
    out[remote] = booleans.includes(remote) ? Boolean(value) : value;
  }
  return out;
}

/** Translate a server row into the local shape. */
function toLocal(tableName, row) {
  // COLUMN_MAP is { local: remote }, so the reverse lookup swaps the pair. Getting this
  // direction wrong means an incoming booking references a column that does not exist
  // locally, and the stored row silently loses the link to its unit.
  const mapping = COLUMN_MAP[tableName] ?? {};
  const reverse = Object.fromEntries(Object.entries(mapping).map(([local, remote]) => [remote, local]));
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "tenant_id") continue;
    out[reverse[key] ?? key] = toLocalValue(value);
  }
  return out;
}

/**
 * Convert a value that arrived as JSON into something SQLite can bind.
 *
 * A `jsonb` column comes back already parsed, so `conflict_details` is an object where the
 * local column is TEXT. sql.js cannot bind an object — it throws "tried to bind a value of an
 * unknown type ([object Object])" — which failed the entire pull, and with it the sync, the
 * moment a conflicting booking was downloaded. A boolean is the same problem in reverse: the
 * local schema stores 0/1 integers.
 */
function toLocalValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const { isArray } = Array;
    return isArray(value) ? JSON.stringify(value) : JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/**
 * Decide whether an incoming server row should replace the local one.
 *
 * The server's `updated_at` is authoritative because the server stamped it. The local
 * row's value is whatever the device wrote, which may be skewed — so the comparison uses
 * the server's clock as the single reference and falls back to the writer id only as a
 * deterministic tie-break.
 */
function shouldAdopt(incoming, local) {
  if (!local) return true;
  const incomingAt = String(incoming.updated_at ?? "");
  const localAt = String(local.updated_at ?? "");
  if (incomingAt !== localAt) return incomingAt > localAt;
  // Same instant: prefer the server's copy. It is the one every other replica will also
  // converge on, so adopting it cannot cause divergence.
  return true;
}

/**
 * Create the sync engine.
 *
 * `transport` is injected rather than imported so the engine can be exercised without a
 * server, and so the Electron main process can supply an authenticated client while tests
 * supply a stub.
 */
function createSyncEngine({ db, transport, nowIso, deviceId, onStateChange }) {
  let syncing = false;
  let lastResult = null;

  function readLocalRow(tableName, rowId) {
    return db.query(`SELECT * FROM ${tableName} WHERE id = ?`, [rowId])[0] ?? null;
  }

  function readWatermark() {
    const stored = db.scalar("SELECT setting_value FROM app_settings WHERE setting_key = 'sync_cursor'");
    const value = Number.parseInt(stored ?? "0", 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function writeWatermark(version) {
    db.run(
      `INSERT INTO app_settings(id, setting_key, setting_value, created_at, updated_at, version, last_writer)
       VALUES (?, 'sync_cursor', ?, ?, ?, 1, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
      [deviceId(), String(version), nowIso(), nowIso(), deviceId()],
    );
  }

  /** Apply incoming changes to the local database. */
  function applyChanges(changes) {
    const applied = { applied: 0, skipped: 0 };
    for (const [tableName, spec] of Object.entries(TABLE_MAP)) {
      const rows = changes[spec.remote];
      if (!Array.isArray(rows)) continue;
      for (const remoteRow of rows) {
        const localRow = toLocal(tableName, remoteRow);
        const id = localRow.id;
        if (!id) continue;

        const existing = readLocalRow(spec.local, id);
        if (!shouldAdopt(remoteRow, existing)) {
          applied.skipped += 1;
          continue;
        }

        const columns = Object.keys(localRow);
        db.run(
          `INSERT INTO ${spec.local}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
           ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`,
          columns.map((column) => localRow[column]),
        );
        applied.applied += 1;

        // A row that arrived from the server is by definition already there, so any
        // pending outbox entry for it is obsolete. Leaving it would push the row straight
        // back and, worse, make the next pull look like a change the client made.
        db.run(`DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ?`, [tableName, id]);
      }
    }
    return applied;
  }

  /** Push everything waiting, then pull what changed. */
  async function sync() {
    if (syncing) return { skipped: true, reason: "already_running" };
    syncing = true;
    try {
      const result = { pushed: 0, applied: 0, conflicts: 0, rejected: 0, stale: 0, cursor: readWatermark() };
      // Set when the server refuses a row that may succeed later; blocks the pull below.
      let unconfirmed = 0;
      // Rows the server will never accept. Reported, left queued, but they do not block.
      let permanentFailures = 0;

      // --- push ---
      const entries = pending(db);
      if (entries.length > 0) {
        const changes = {};
        const sent = [];
        for (const entry of entries) {
          // The payload is read from the LIVE row, not from the stored payload. If the row
          // changed after the entry was written, sending the stale copy would overwrite
          // the newer local edit on the server — the local database is the truth about
          // this device's intent.
          const current = readLocalRow(entry.table_name, entry.row_id);
          if (!current) {
            // The row is gone locally. A hard delete never happens (deletes are soft), so
            // this means the entry is orphaned; dropping it keeps the queue from growing
            // forever around rows that no longer exist.
            db.run(`DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ?`, [entry.table_name, entry.row_id]);
            continue;
          }
          const spec = TABLE_MAP[entry.table_name];
          if (!spec) continue;
          changes[spec.remote] = changes[spec.remote] ?? [];
          changes[spec.remote].push(toRemote(entry.table_name, current));
          // The revision read here is the one being sent. Acknowledging by it, rather
          // than by whatever is current when the response arrives, leaves a concurrent
          // edit queued instead of deleting it.
          sent.push({ ...entry, sentRevision: entry.revision });
        }

        if (sent.length > 0) {
          // Rebuild the payload in dependency order rather than trusting insertion order.
          const ordered = {};
          for (const remote of SYNC_ORDER) {
            if (changes[remote]) ordered[remote] = changes[remote];
          }
          // Anything the client sends that is not in the list would be dropped, which would
          // lose data silently — so it is carried through in its original position instead.
          for (const [remote, rows] of Object.entries(changes)) {
            if (!(remote in ordered)) ordered[remote] = rows;
          }
          const response = await transport.push({ clientId: deviceId(), changes: ordered });

          // Only entries the server actually stored are acknowledged. A row it rejected
          // stays queued so the problem is visible rather than silently dropped.
          const accepted = new Set(
            (response.results ?? [])
              .filter((row) => row.outcome === "applied" || row.outcome === "stale" || row.outcome === "conflict")
              .map((row) => `${row.table}:${row.id}`),
          );
          const remoteToLocal = Object.fromEntries(Object.entries(TABLE_MAP).map(([local, spec]) => [spec.remote, local]));

          // Which rows the server refused for good, versus ones worth retrying. A permanent
          // refusal (over the plan allowance, or a value the schema rejects) is recorded and
          // left queued, but it must NOT hold up the pull: otherwise a single over-allowance
          // unit stops the account syncing anything for the rest of its life.
          const permanentRejections = new Set(
            (response.results ?? [])
              .filter((row) => row.outcome === "rejected" && !row.retryable)
              .map((row) => ({ table: row.table, id: row.id })),
          );
          const rejectKey = (tableName, rowId) => {
            const spec = TABLE_MAP[tableName];
            return spec ? `${spec.remote}:${rowId}` : `${tableName}:${rowId}`;
          };
          const permanent = new Set([...permanentRejections].map((r) => rejectKey(r.table, r.id)));

          const toAcknowledge = [];
          for (const entry of sent) {
            const spec = TABLE_MAP[entry.table_name];
            const key = `${spec.remote}:${entry.row_id}`;
            if (accepted.has(key)) {
              toAcknowledge.push(entry);
            } else if (permanent.has(key)) {
              permanentFailures += 1;
              recordFailure(db, entry, "сервер отклонил запись (нельзя исправить повтором)", nowIso);
            } else {
              unconfirmed += 1;
              recordFailure(db, entry, "сервер не подтвердил запись", nowIso);
            }
          }
          acknowledge(db, toAcknowledge);
          result.pushed = toAcknowledge.length;
          result.conflicts = response.conflicts ?? 0;
          result.rejected = response.rejected ?? 0;
          result.stale = response.stale ?? 0;
          void remoteToLocal;
        }
      }

      // A push the server did not fully accept stops the sync here.
      //
      // The pull must not run after a partial rejection. Applying server rows deletes the
      // outbox entry for each row it writes — correctly, since those rows are already on the
      // server — but when the PUSH was refused, the server's copy is the OLD state. Pulling
      // then overwrites the local edit AND deletes its queue entry, so the user's change is
      // gone from both sides with nothing left to retry. The queue is the only record of
      // intent; it survives a failure only if the pull is skipped.
      if (unconfirmed > 0) {
        result.rejected = unconfirmed;
        lastResult = {
          ok: false,
          at: nowIso(),
          ...result,
          error: `${unconfirmed} change(s) were not accepted by the server; nothing was pulled, and the queue is intact`,
          pending: pendingCount(db),
        };
        if (onStateChange) onStateChange(lastResult);
        return lastResult;
      }

      // --- pull ---
      // The cursor only advances after the changes are stored, so an interrupted pull
      // re-fetches rather than skipping data.
      const pulled = await transport.pull(readWatermark());
      const applied = applyChanges(pulled.changes ?? {});
      result.applied = applied.applied;
      result.cursor = pulled.state?.version ?? readWatermark();
      writeWatermark(result.cursor);
      db.persist();

      lastResult = { ok: true, at: nowIso(), ...result };
      if (onStateChange) onStateChange(lastResult);
      return lastResult;
    } catch (error) {
      // A failed sync must never lose queued work: the outbox is untouched except for the
      // failure note, so the next attempt resends it.
      lastResult = { ok: false, at: nowIso(), error: error?.message ?? String(error), pending: pendingCount(db) };
      if (onStateChange) onStateChange(lastResult);
      return lastResult;
    } finally {
      syncing = false;
    }
  }

  return {
    applyChanges,
    lastResult: () => lastResult,
    pendingCount: () => pendingCount(db),
    queue: (tableName, rowId, payload) => enqueue(db, tableName, rowId, payload, nowIso),
    readWatermark,
    sync,
    toLocal,
    toRemote,
  };
}

module.exports = {
  COLUMN_MAP,
  SERVER_OWNED,
  TABLE_MAP,
  createSyncEngine,
  shouldAdopt,
  toLocal,
  toRemote,
};

/**
 * How the account is configured: the booking window, the language, and the licence cache.
 *
 * These eight are one group because they answer one question, and because `upsertSetting` is the
 * only way any of them is written. That method reads the row back after writing to build the sync
 * payload, which is why the whole group looked welded to the storage layer: it is, and the store's
 * `enqueueSync` is the seam to pass through rather than around.
 *
 * `enqueueSync` is in the interface on purpose. It is the store's "this row changed, it has to
 * reach the server", which is storage vocabulary and not a domain operation. A module that instead
 * reached for `createReservation` would be the split going wrong.
 *
 * `upsertSetting` writes only to the in-memory database. Every setter here calls `persist` itself,
 * and a cache that does not survive a restart is useless exactly when it is needed, which is
 * offline on a licensed device.
 */

const ALLOWED_INTERFACE_LANGUAGES = new Set(["ru", "az", "en"]);

const crypto = require("node:crypto");

const DEVICE_PRIVATE_SETTINGS = new Set([
  "entitlements",
  "device_id",
  "sync_cursor",
]);

const { nowIso } = require("./clock.cjs");
const { resolvePolicy } = require("./booking/booking-policy.cjs");
// The licence cache is read as a value, so the read lives with the other screen reads.
const { entitlements, listProperties } = require("./reports.cjs");

function upsertSetting(store, key, value) {
    const timestamp = nowIso();
    store.run(
      `INSERT INTO app_settings(id, setting_key, setting_value, created_at, updated_at, version, last_writer)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at,
         version = version + 1,
         last_writer = excluded.last_writer`,
      [crypto.randomUUID(), key, value, timestamp, timestamp, store.writerId],
    );
    // Per-device settings are stored but never queued for sending.
    //
    // `app_settings` is a replicated table, so anything written here travels to every device
    // that shares the account. Three of these keys must not:
    //
    //   entitlements — each device fetches its own licence from the server. Syncing it makes
    //     one device's cache overwrite another's, so a licensed device can inherit a stale
    //     "not paid" cache and be treated as unlicensed.
    //   device_id    — identifies THIS installation. Replicating it makes every device claim
    //     the same writer, which destroys the only record of which device made a change.
    //   sync_cursor  — a per-device read position. A device that inherited another's cursor
    //     would skip every change made before it.
    //
    // They are written through `db.run` rather than this method by the sync engine itself, but
    // the guard lives here so a future caller cannot reintroduce the problem.
    if (DEVICE_PRIVATE_SETTINGS.has(key)) return;

    // Settings are keyed by setting_key rather than id, so the row is looked up by key.
    const stored = store.query("SELECT id FROM app_settings WHERE setting_key = ?", [key])[0];
    if (stored) store.enqueueSync("app_settings", stored.id);
  }


function bookingPolicy(store) {
    const stored = store.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'booking_policy'",
    );
    if (!stored) return resolvePolicy(null);
    try {
      return resolvePolicy(JSON.parse(stored));
    } catch {
      // A corrupt cache must not brick booking: an unreadable policy degrades to the
      // shipped default, which is a real window rather than a lockout.
      return resolvePolicy(null);
    }
  }

  /**
   * Record the policy the server reported.
   *
   * Stored through the ordinary settings path so it syncs like any other setting and
   * survives a restart.
   */

function setBookingPolicy(store, policy) {
    const resolved = resolvePolicy(policy);
    upsertSetting(store, "booking_policy", JSON.stringify({
      maximumAdvanceDays: resolved.maximumAdvanceDays,
      maximumStayMonths: resolved.maximumStayMonths,
      timeZone: resolved.timeZone,
    }));
    // Persist immediately. `upsertSetting` only writes to the in-memory database, and the file
    // is rewritten by the mutating methods that wrap themselves in `transaction`. Without this
    // the cached window lives only until the next restart — which is precisely the situation
    // the cache exists for, since an offline device restarts with no way to re-fetch it.
    store.persist();
    return resolved;
  }

  /**
   * The account's entitlements, as most recently reported by the server.
   *
   * Cached locally for the same reason the booking policy is: the application must work
   * offline, and a licence check that needed the network would make the app unusable on a
   * train. The server stays authoritative — it re-checks on every write that matters — so
   * this cache can only ever be too permissive for a short window, never permanently.
   */

function getLanguage(store) {
    const language = store.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'interface_language'",
    );
    return ALLOWED_INTERFACE_LANGUAGES.has(language) ? language : "ru";
  }


function setLanguage(store, language) {
    const normalized = String(language ?? "").trim().toLowerCase();
    if (!ALLOWED_INTERFACE_LANGUAGES.has(normalized)) {
      throw new Error("Доступные языки интерфейса: ru, az, en");
    }
    upsertSetting(store, "interface_language", normalized);
    store.audit("settings", null, "language_changed", { language: normalized });
    store.persist();
    return normalized;
  }


function setEntitlements(store, next) {
    upsertSetting(store, "entitlements", JSON.stringify({ ...next, cachedAt: nowIso() }));
    // Persisted for the same reason as the booking policy: a licence cached only in memory
    // would be lost on restart, and a licensed user opening the app offline would be treated
    // as unlicensed.
    store.persist();
    return entitlements(store);
  }

  /**
   * How many active units this account may hold, or null for unlimited.
   *
   * With no cached entitlement the free cap applies. That is the conservative direction: a
   * device that has never synced must not assume it is licensed.
   */

function unitAllowance(store) {
    const stored = entitlements(store);
    if (!stored) return 1;
    return stored.paid ? stored.unitLimit : 1;
  }

  /**
   * Whether the account is over its unit allowance, for the upgrade prompt.
   *
   * ADVISORY ONLY — this deliberately does not refuse writes.
   *
   * The server enforces the limit, and it is the only place that can: it holds the licence,
   * it sees every device, and it already has a database trigger closing the race. Refusing
   * locally would break the two cases the product depends on. A licensed user whose cache
   * has expired, or who is offline on a new device, would be locked out of their own data —
   * and the demo dataset, which the application seeds on first run, would fail to load.
   *
   * So the client creates the unit and lets the server refuse it, and the refusal is shown
   * rather than hidden. That is the honest failure: the user learns the limit at the moment
   * it applies, with their data intact and nothing lost.
   */

function unitAllowanceStatus(store) {
    const allowance = unitAllowance(store);
    const active = listProperties(store, { includeArchived: true })
      .filter((item) => item.status === "active" && !item.deleted_at).length;
    if (allowance === null) {
      return { unlimited: true, allowance: null, active, remaining: null, over: false };
    }
    return {
      unlimited: false,
      allowance,
      active,
      remaining: Math.max(0, allowance - active),
      over: active > allowance,
    };
  }

  /** How many local changes are waiting to reach the server. */

module.exports = {
  ALLOWED_INTERFACE_LANGUAGES,
  DEVICE_PRIVATE_SETTINGS,
  upsertSetting,
  bookingPolicy,
  setBookingPolicy,
  getLanguage,
  setLanguage,
  setEntitlements,
  unitAllowance,
  unitAllowanceStatus,
};

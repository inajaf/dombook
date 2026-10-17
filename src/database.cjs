const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { nowIso, todayIso } = require("./domain/clock.cjs");
const { integer } = require("./domain/fields.cjs");
const { migrate } = require("./domain/migrations.cjs");
const initSqlJs = require("sql.js");
const {
  enqueue: enqueueOutbox,
  pending,
  pendingCount,
  acknowledge,
  recordFailure,
  // Entries the server refused for good. Reported, never silently dropped.
  failed,
} = require("./main/outbox.cjs");
const {
  assertBookingDates,
  bookingLimits,
  resolvePolicy,
  wholeMonthsBetween,
  todayInTimeZone,
} = require("./domain/booking/booking-policy.cjs");
const {
  parseRateRules,
  quoteReservation,
  quoteTenancy,
  serializeRateRules,
  validateRateRules,
} = require("./domain/booking/pricing.cjs");

/**
 * Settings that belong to one installation and must never replicate.
 *
 * `app_settings` is a synced table, so a key written here reaches every device on the account.
 * These three must not: a licence cache, a device identity, and a read cursor are all
 * per-device facts, and sharing them produces wrong answers rather than merely noisy ones.
 */
const DEVICE_PRIVATE_SETTINGS = new Set([
  "entitlements",
  "device_id",
  "sync_cursor",
]);

const ALLOWED_RESERVATION_STATUSES = new Set([
  "hold",
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
  // Server-assigned. It is accepted here so that editing an unrelated field on a conflicted
  // booking — a phone number, a note — does not silently rewrite its status to "hold" and
  // drop it out of the operator's queue.
  "conflict",
]);

const ALLOWED_DEPOSIT_STATUSES = new Set([
  "none",
  "due",
  "received",
  "returned",
  "partially_withheld",
  "withheld",
]);

const ALLOWED_MEAL_TYPES = new Set(["breakfast", "lunch", "dinner"]);
const ALLOWED_INTERFACE_LANGUAGES = new Set(["ru", "az", "en"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Domain tables carry the same sync columns as the SaaS baseline
// (backend/migrations/0001_baseline.sql): UUID TEXT id, created_at/updated_at,
// soft-delete deleted_at, version (bumped on every write) and last_writer.
// The desktop is single-tenant, so tenant_id columns are omitted here.


/**
 * Normalise meter readings for storage.
 *
 * Stored as a JSON string, defaulting to "{}" rather than NULL so every read has a string
 * to parse. An unparseable value becomes "{}" rather than throwing: meter readings are
 * reference data an operator typed in, and losing a whole booking because of a typo in them
 * would be a far worse failure than losing the readings.
 */
function normalizeMeterReadings(raw) {
  if (raw === undefined || raw === null || raw === "") return "{}";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : "{}";
    } catch {
      return "{}";
    }
  }
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "{}";
    }
  }
  return "{}";
}


function requiredText(value, label, max = 200) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label}: обязательное поле`);
  if (result.length > max) throw new Error(`${label}: максимум ${max} символов`);
  return result;
}

function optionalText(value, max = 2000) {
  const result = String(value ?? "").trim();
  if (result.length > max) throw new Error(`Текст: максимум ${max} символов`);
  return result;
}

function money(value, label) {
  return integer(value, label, 0, 1_000_000_000);
}

function uuid(value, label = "Идентификатор") {
  const result = String(value ?? "").trim();
  if (!UUID_PATTERN.test(result)) throw new Error(`${label}: неверный идентификатор`);
  return result;
}

function validDate(value, label) {
  const result = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error(`${label}: неверная дата`);
  }
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label}: неверная дата`);
  }
  return result;
}

function eachNight(checkIn, checkOut) {
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  if (end <= start) throw new Error("Дата выезда должна быть позже даты заезда");
  const result = [];
  for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    result.push(cursor.toISOString().slice(0, 10));
    if (result.length > 730) throw new Error("Бронирование не может быть длиннее 730 ночей");
  }
  return result;
}

function normalizePhone(value) {
  return String(value ?? "").replace(/[^\d+]/g, "").slice(0, 32);
}

function canonicalName(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}

/** How many backups stay on disk. The newest are kept, the rest are removed on each new backup. */
const BACKUP_LIMIT = 10;

class RentKeeperDatabase {
  constructor({ filePath, backupDir, seed = true, todayProvider = todayInTimeZone }) {
    this.filePath = filePath;
    this.backupDir = backupDir;
    this.seed = seed;
    this.todayProvider = todayProvider;
    this.db = null;
    this.SQL = null;
    this.writerId = "";
  }

  async init() {
    let wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    if (wasmPath.includes("app.asar")) {
      const unpackedPath = wasmPath.replace("app.asar", "app.asar.unpacked");
      if (fs.existsSync(unpackedPath)) {
        wasmPath = unpackedPath;
      }
    }
    this.SQL = await initSqlJs({ locateFile: () => wasmPath });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });

    if (fs.existsSync(this.filePath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.filePath));
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run("PRAGMA foreign_keys = ON");
    migrate(this);
    this.ensureDeviceId();
    if (this.seed) this.seedDemoData();
    this.persist();
    return this;
  }
  insertRowRaw(table, row) {
    const columns = Object.keys(row);
    this.db.run(
      `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => row[column]),
    );
  }

  insertRow(table, row) {
    const columns = Object.keys(row);
    this.db.run(
      `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => row[column]),
    );
    this.enqueueSync(table, row.id);
  }

  /**
   * Record a row's current state as needing to be pushed to the server.
   *
   * The payload is read back from the database rather than passed in, so it is always the
   * row as actually stored — including the version and timestamp the write just produced.
   * Passing the caller's input would risk queueing something the database then modified.
   *
   * Call this inside the same transaction as the write it describes. A queue that can
   * disagree with the data either resends a change that was rolled back or loses one that
   * committed, which is the failure the outbox exists to prevent.
   *
   * Failures are logged and swallowed: a sync bookkeeping problem must never abort the
   * user's write, which has already succeeded locally and is their actual intent.
   */
  enqueueSync(table, rowId) {
    if (!rowId || this.syncEnabled === false) return;
    try {
      const row = this.query(`SELECT * FROM ${table} WHERE id = ?`, [rowId])[0];
      if (!row) return;
      enqueueOutbox(this, table, rowId, row, nowIso);
    } catch (error) {
      console.error("Не удалось поставить запись в очередь синхронизации", error);
    }
  }

  /**
   * The account's booking window, as most recently reported by the server.
   *
   * Cached locally rather than fetched per booking: the application must work offline, and
   * a validation rule that needed the network would make booking impossible without one.
   * The shipped defaults apply until the server has been heard from.
   */
  bookingPolicy() {
    const stored = this.scalar(
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
  setBookingPolicy(policy) {
    const resolved = resolvePolicy(policy);
    this.upsertSetting("booking_policy", JSON.stringify({
      maximumAdvanceDays: resolved.maximumAdvanceDays,
      maximumStayMonths: resolved.maximumStayMonths,
      timeZone: resolved.timeZone,
    }));
    // Persist immediately. `upsertSetting` only writes to the in-memory database, and the file
    // is rewritten by the mutating methods that wrap themselves in `transaction`. Without this
    // the cached window lives only until the next restart — which is precisely the situation
    // the cache exists for, since an offline device restarts with no way to re-fetch it.
    this.persist();
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
  entitlements() {
    const stored = this.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'entitlements'",
    );
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      // `unitLimit: null` means unlimited, so the distinction between "no cache" and
      // "unlimited" has to survive JSON. Reading a missing field as unlimited would hand
      // out the paid tier on a corrupt cache.
      return {
        paid: parsed.paid === true,
        planName: typeof parsed.planName === "string" ? parsed.planName : "",
        skus: Array.isArray(parsed.skus) ? parsed.skus : [],
        expiresAt: parsed.expiresAt ?? null,
        // A missing unitLimit with paid=false is treated as the free cap rather than as
        // unlimited, so the failure mode is a refusal instead of a giveaway.
        unitLimit: parsed.paid === true && parsed.unitLimit === null
          ? null
          : Number.isInteger(parsed.unitLimit) ? parsed.unitLimit : 1,
        features: Array.isArray(parsed.features) ? parsed.features : [],
        cachedAt: parsed.cachedAt ?? null,
        stale: true,
      };
    } catch {
      return null;
    }
  }

  /** Record the entitlements the server reported. */
  setEntitlements(entitlements) {
    this.upsertSetting("entitlements", JSON.stringify({ ...entitlements, cachedAt: nowIso() }));
    // Persisted for the same reason as the booking policy: a licence cached only in memory
    // would be lost on restart, and a licensed user opening the app offline would be treated
    // as unlicensed.
    this.persist();
    return this.entitlements();
  }

  /**
   * How many active units this account may hold, or null for unlimited.
   *
   * With no cached entitlement the free cap applies. That is the conservative direction: a
   * device that has never synced must not assume it is licensed.
   */
  unitAllowance() {
    const entitlements = this.entitlements();
    if (!entitlements) return 1;
    return entitlements.paid ? entitlements.unitLimit : 1;
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
  unitAllowanceStatus() {
    const allowance = this.unitAllowance();
    const active = this.listProperties({ includeArchived: true })
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
  pendingSyncCount() {
    return pendingCount(this);
  }

  /**
   * Queued changes the server has refused for good.
   *
   * They stay in the outbox rather than being dropped — the user's data is theirs, and a
   * silent discard is the worst outcome. But they will never drain, so the count is reported
   * separately instead of leaving the "unsynced" badge stuck at a number nobody can explain.
   */
  failedSyncCount() {
    return failed(this).length;
  }

  /** Pending entries, for the sync engine to push. */
  pendingSyncEntries(limit = 500) {
    return pending(this, limit);
  }

  acknowledgeSync(entries) {
    return acknowledge(this, entries);
  }

  recordSyncFailure(entry, message) {
    return recordFailure(this, entry, message);
  }
  ensureDeviceId() {
    const existing = this.scalar("SELECT setting_value FROM app_settings WHERE setting_key = 'device_id'");
    if (existing) {
      this.writerId = existing;
      return;
    }
    this.writerId = crypto.randomUUID();
    this.upsertSetting("device_id", this.writerId);
    this.persist();
  }

  /**
   * The sample dataset shown on first run.
   *
   * It creates ONE place and ONE unit — not more. The free tier allows one active place and
   * one active unit, and the server enforces that with a trigger, so a larger seed produced a
   * demonstration the user could never sync: their very first push was refused by the plan
   * limit. A sample that cannot leave the device is worse than no sample.
   *
   * One of each still shows how places, units, the calendar and the rentals screen fit
   * together, and the user's own data is what the app is for anyway.
   */
  seedDemoData() {
    const count = this.scalar("SELECT COUNT(*) FROM properties");
    if (count > 0) return;

    const place = this.createPlace(
      { name: "Дом отдыха «Лесная долина»", address: "Габала", notes: "Демонстрационный комплекс" },
      { persist: false, audit: false },
    );
    this.createProperty({
      name: "Коттедж «Сосны»", kind: "cottage", placeId: place.id, location: "", capacity: 6,
      basePriceMinor: 24000, monthlyRateMinor: 480000, depositMinor: 30000,
      notes: "Тихий коттедж рядом с лесом",
    }, { persist: false, audit: false });
  }

  query(sql, params = []) {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  scalar(sql, params = []) {
    const rows = this.query(sql, params);
    if (!rows.length) return null;
    return Object.values(rows[0])[0];
  }

  run(sql, params = []) {
    this.db.run(sql, params);
  }

  transaction(callback) {
    this.db.run("BEGIN IMMEDIATE");
    let result;
    try {
      result = callback();
      this.db.run("COMMIT");
    } catch (error) {
      try {
        this.db.run("ROLLBACK");
      } catch (rollbackError) {
        console.error("Не удалось откатить транзакцию", rollbackError);
      }
      throw error;
    }
    this.persist();
    return result;
  }

  /**
   * Whether this device has ever exchanged anything with the server.
   *
   * A device that has not is holding nothing but the demo seed — and pushing that seed into an
   * account that already exists is refused ("Такое название уже используется"), which matters far
   * more than the refusal itself: a refused push SKIPS the pull, so the device never receives the
   * account's data at all. That is what a second device, or any device whose profile has just been
   * recreated, does on its first sign-in: it shows the sample and nothing else, forever.
   *
   * The cursor is per-device and never replicated, so it is a reliable "this installation has
   * never heard from the server" signal.
   */
  hasNeverSynced() {
    const cursor = Number(this.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'sync_cursor'",
    ) || 0);
    return !(cursor > 0);
  }

  /**
   * Throw the local database away and start from an empty one.
   *
   * Called when a DIFFERENT account signs in on this device. The local database is a replica of
   * one account's server state plus that account's unsent edits, and it has no tenant column —
   * the desktop is single-tenant by design. Keeping it across a sign-in means the next account
   * sees the previous one's bookings, and the pull that follows collides with what is already
   * there: "UNIQUE constraint failed: places.name", a sync that never recovers, and queued rows
   * belonging to someone else waiting to be pushed into the account that just signed in.
   *
   * No demo seed: this runs when a real account signs in, and sample data would be pushed into it.
   */
  reset() {
    this.db.close();
    fs.rmSync(this.filePath, { force: true });
    this.db = new this.SQL.Database();
    this.db.run("PRAGMA foreign_keys = ON");
    migrate(this);
    this.ensureDeviceId();
    this.persist();
    return this;
  }

  persist() {
    const bytes = Buffer.from(this.db.export());
    const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, bytes);
      fs.renameSync(tempPath, this.filePath);
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }

  audit(entityType, entityId, action, payload = {}) {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO audit_log(id, entity_type, entity_id, action, payload_json, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [crypto.randomUUID(), entityType, entityId ?? null, action, JSON.stringify(payload), timestamp, timestamp],
    );
  }

  listProperties({ includeArchived = true } = {}) {
    const where = includeArchived ? "" : "WHERE p.status = 'active'";
    return this.query(`
      SELECT p.*, pl.name AS place_name, pl.address AS place_address,
        (SELECT COUNT(*) FROM reservations r
          WHERE r.property_id = p.id AND r.status NOT IN ('cancelled', 'no_show')) AS reservation_count
      FROM properties p
      LEFT JOIN places pl ON pl.id = p.place_id
      ${where}
      ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END,
        COALESCE(pl.name, p.name) COLLATE NOCASE, p.name COLLATE NOCASE
    `);
  }

  listPlaces({ includeArchived = true } = {}) {
    const where = includeArchived ? "" : "WHERE pl.status = 'active'";
    return this.query(`
      SELECT pl.*,
        (SELECT COUNT(*) FROM properties p WHERE p.place_id = pl.id AND p.status = 'active') AS active_unit_count,
        (SELECT COUNT(*) FROM properties p WHERE p.place_id = pl.id) AS total_unit_count
      FROM places pl
      ${where}
      ORDER BY CASE pl.status WHEN 'active' THEN 0 ELSE 1 END, pl.name COLLATE NOCASE
    `);
  }

  getPlace(id) {
    return this.query("SELECT * FROM places WHERE id = ?", [uuid(id, "Дом отдыха")])[0] ?? null;
  }

  validatePlace(input) {
    const hasFoodService = input.hasFoodService === true || input.hasFoodService === 1 || input.hasFoodService === "1";
    return {
      name: requiredText(input.name, "Название дома отдыха", 140),
      address: optionalText(input.address, 240),
      hasFoodService: hasFoodService ? 1 : 0,
      breakfastPriceMinor: hasFoodService ? money(input.breakfastPriceMinor ?? 0, "Цена завтрака") : 0,
      lunchPriceMinor: hasFoodService ? money(input.lunchPriceMinor ?? 0, "Цена обеда") : 0,
      dinnerPriceMinor: hasFoodService ? money(input.dinnerPriceMinor ?? 0, "Цена ужина") : 0,
      notes: optionalText(input.notes, 2000),
      status: input.status === "archived" ? "archived" : "active",
    };
  }

  createPlace(input, options = {}) {
    const data = this.validatePlace(input);
    const timestamp = nowIso();
    const create = () => {
      const duplicate = this.listPlaces().find((place) => canonicalName(place.name) === canonicalName(data.name));
      if (duplicate) throw new Error("Дом отдыха с таким названием уже существует");
      const id = crypto.randomUUID();
      this.run(
        `INSERT INTO places(
          id, name, address, has_food_service, breakfast_price_minor, lunch_price_minor,
          dinner_price_minor, status, notes, created_at, updated_at, version, last_writer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, data.name, data.address, data.hasFoodService, data.breakfastPriceMinor, data.lunchPriceMinor,
          data.dinnerPriceMinor, data.status, data.notes, timestamp, timestamp, this.writerId],
      );
      this.enqueueSync("places", id);
      if (options.audit !== false) this.audit("place", id, "created", data);
      return this.getPlace(id);
    };
    if (options.persist === false) return create();
    return this.transaction(create);
  }

  updatePlace(id, input) {
    const placeId = uuid(id, "Дом отдыха");
    if (!this.getPlace(placeId)) throw new Error("Дом отдыха не найден");
    const data = this.validatePlace(input);
    return this.transaction(() => {
      const duplicate = this.listPlaces().find(
        (place) => place.id !== placeId && canonicalName(place.name) === canonicalName(data.name),
      );
      if (duplicate) throw new Error("Дом отдыха с таким названием уже существует");
      this.run(
        `UPDATE places SET name = ?, address = ?, has_food_service = ?, breakfast_price_minor = ?,
          lunch_price_minor = ?, dinner_price_minor = ?, status = ?, notes = ?,
          updated_at = ?, version = version + 1, last_writer = ?
        WHERE id = ?`,
        [data.name, data.address, data.hasFoodService, data.breakfastPriceMinor, data.lunchPriceMinor,
          data.dinnerPriceMinor, data.status, data.notes, nowIso(), this.writerId, placeId],
      );
      this.enqueueSync("places", placeId);
      this.audit("place", placeId, "updated", data);
      return this.getPlace(placeId);
    });
  }

  archivePlace(id) {
    const placeId = uuid(id, "Дом отдыха");
    if (!this.getPlace(placeId)) throw new Error("Дом отдыха не найден");
    return this.transaction(() => {
      this.run(
        "UPDATE places SET status = 'archived', updated_at = ?, version = version + 1, last_writer = ? WHERE id = ?",
        [nowIso(), this.writerId, placeId],
      );
      this.enqueueSync("places", placeId);
      this.audit("place", placeId, "archived");
      return this.getPlace(placeId);
    });
  }

  restorePlace(id) {
    const placeId = uuid(id, "Дом отдыха");
    if (!this.getPlace(placeId)) throw new Error("Дом отдыха не найден");
    return this.transaction(() => {
      this.run(
        "UPDATE places SET status = 'active', updated_at = ?, version = version + 1, last_writer = ? WHERE id = ?",
        [nowIso(), this.writerId, placeId],
      );
      this.enqueueSync("places", placeId);
      this.audit("place", placeId, "restored");
      return this.getPlace(placeId);
    });
  }

  getProperty(id) {
    return this.query("SELECT * FROM properties WHERE id = ?", [uuid(id, "Дом")])[0] ?? null;
  }

  validateProperty(input) {
    const placeId = input.placeId === null || input.placeId === "" || input.placeId === undefined
      ? null
      : uuid(input.placeId, "Дом отдыха");
    if (placeId) {
      const place = this.getPlace(placeId);
      if (!place || place.status !== "active") throw new Error("Выберите активный дом отдыха");
    }
    return {
      placeId,
      kind: input.kind === "cottage" ? "cottage" : "house",
      name: requiredText(input.name, "Наименование дома", 120),
      location: optionalText(input.location, 200),
      capacity: integer(input.capacity, "Вместимость", 1, 100),
      basePriceMinor: money(input.basePriceMinor, "Базовая цена"),
      // The rent for a long-term let. Defaults to 0, meaning the unit is not offered for
      // rent — which is how the Rentals screen decides what to list, rather than a separate
      // availability flag that could disagree with the price.
      monthlyRateMinor: money(input.monthlyRateMinor ?? 0, "Месячная ставка"),
      // Seasons and length discounts, as the unit's own pricing rules.
      //
      // Refused on WRITE when two seasons overlap, because the price would then depend on the
      // order of a list nobody can see in the editor. Read back tolerantly (parseRateRules),
      // because a row written by an older client must still be bookable at its base rate.
      rateRules: this.validatePropertyRateRules(input.rateRules),
      depositMinor: money(input.depositMinor, "Депозит"),
      currency: requiredText(input.currency || "AZN", "Валюта", 3).toUpperCase(),
      checkInTime: requiredText(input.checkInTime || "15:00", "Время заезда", 5),
      checkOutTime: requiredText(input.checkOutTime || "11:00", "Время выезда", 5),
      notes: optionalText(input.notes, 2000),
      status: input.status === "archived" ? "archived" : "active",
    };
  }

  /**
   * Store a unit's pricing rules as JSON text, refusing one that could not be priced.
   *
   * `validateRateRules` answers in stable codes so the rule stays testable, and the codes are
   * turned into prose here — the one place that owns the wording.
   */
  validatePropertyRateRules(input) {
    if (input === undefined || input === null || input === "") return "{}";
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    const codes = validateRateRules(raw);
    if (codes.length) {
      const messages = {
        rate_rules_unreadable: "Правила цен заполнены неверно",
        seasons_overlap: "Сезоны пересекаются по датам — оставьте непересекающиеся периоды",
        season_range_inverted: "У сезона дата окончания раньше даты начала",
        season_rate_missing: "У сезона не указана цена за ночь",
        stay_discount_threshold_too_low: "Скидка за длительность действует от двух ночей",
        stay_discount_percent_missing: "У скидки за длительность не указан процент",
        tenancy_discount_threshold_too_low: "Скидка на аренду действует от двух месяцев",
        tenancy_discount_percent_missing: "У скидки на аренду не указан процент",
      };
      throw new Error(messages[codes[0]] || "Правила цен заполнены неверно");
    }
    return serializeRateRules(parseRateRules(raw));
  }

  createProperty(input, options = {}) {
    const data = this.validateProperty(input);
    const timestamp = nowIso();
    const create = () => {
      const duplicate = this.listProperties().find(
        (property) => canonicalName(property.name) === canonicalName(data.name),
      );
      if (duplicate) throw new Error("Объект с таким наименованием уже существует");
      const id = crypto.randomUUID();
      this.run(
        `INSERT INTO properties(
          id, place_id, kind, name, location, capacity, base_price_minor, monthly_rate_minor,
          rate_rules, deposit_minor, currency,
          check_in_time, check_out_time, status, notes, created_at, updated_at, version, last_writer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          id, data.placeId, data.kind, data.name, data.location, data.capacity, data.basePriceMinor,
          data.monthlyRateMinor, data.rateRules, data.depositMinor,
          data.currency, data.checkInTime, data.checkOutTime, data.status, data.notes,
          timestamp, timestamp, this.writerId,
        ],
      );
      this.enqueueSync("properties", id);
      if (options.audit !== false) this.audit("property", id, "created", data);
      return this.getProperty(id);
    };
    if (options.persist === false) return create();
    return this.transaction(create);
  }

  updateProperty(id, input) {
    const propertyId = uuid(id, "Дом");
    if (!this.getProperty(propertyId)) throw new Error("Дом не найден");
    const data = this.validateProperty(input);
    return this.transaction(() => {
      const duplicate = this.listProperties().find(
        (property) => property.id !== propertyId && canonicalName(property.name) === canonicalName(data.name),
      );
      if (duplicate) throw new Error("Объект с таким наименованием уже существует");
      this.run(
        `UPDATE properties SET
          place_id = ?, kind = ?, name = ?, location = ?, capacity = ?, base_price_minor = ?,
          monthly_rate_minor = ?, rate_rules = ?, deposit_minor = ?,
          currency = ?, check_in_time = ?, check_out_time = ?, status = ?, notes = ?,
          updated_at = ?, version = version + 1, last_writer = ?
        WHERE id = ?`,
        [
          data.placeId, data.kind, data.name, data.location, data.capacity, data.basePriceMinor,
          data.monthlyRateMinor, data.rateRules, data.depositMinor,
          data.currency, data.checkInTime, data.checkOutTime, data.status, data.notes,
          nowIso(), this.writerId, propertyId,
        ],
      );
      this.enqueueSync("properties", propertyId);
      this.audit("property", propertyId, "updated", data);
      return this.getProperty(propertyId);
    });
  }

  archiveProperty(id) {
    const propertyId = uuid(id, "Дом");
    if (!this.getProperty(propertyId)) throw new Error("Дом не найден");
    return this.transaction(() => {
      this.run(
        "UPDATE properties SET status = 'archived', updated_at = ?, version = version + 1, last_writer = ? WHERE id = ?",
        [nowIso(), this.writerId, propertyId],
      );
      this.enqueueSync("properties", propertyId);
      this.audit("property", propertyId, "archived");
      return this.getProperty(propertyId);
    });
  }

  restoreProperty(id) {
    const propertyId = uuid(id, "Дом");
    if (!this.getProperty(propertyId)) throw new Error("Дом не найден");
    return this.transaction(() => {
      this.run(
        "UPDATE properties SET status = 'active', updated_at = ?, version = version + 1, last_writer = ? WHERE id = ?",
        [nowIso(), this.writerId, propertyId],
      );
      this.enqueueSync("properties", propertyId);
      this.audit("property", propertyId, "restored");
      return this.getProperty(propertyId);
    });
  }

  listReservations() {
    const reservations = this.query(`
      SELECT r.*, p.name AS property_name, p.currency, pl.name AS place_name,
        MAX(r.total_minor - r.prepaid_minor, 0) AS balance_minor,
        MAX(r.prepaid_minor - r.total_minor, 0) AS refund_due_minor
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      LEFT JOIN places pl ON pl.id = p.place_id
      ORDER BY r.check_in_date DESC, r.created_at DESC, r.id DESC
    `);
    const mealsByReservation = new Map();
    this.query(`
      SELECT reservation_id, meal_date, meal_type, amount_minor
      FROM reservation_meals
      ORDER BY meal_date, CASE meal_type
        WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END
    `).forEach((meal) => {
      const items = mealsByReservation.get(meal.reservation_id) || [];
      items.push(meal);
      mealsByReservation.set(meal.reservation_id, items);
    });
    return reservations.map((reservation) => ({
      ...reservation,
      meals: mealsByReservation.get(reservation.id) || [],
    }));
  }

  getReservation(id) {
    return this.query("SELECT * FROM reservations WHERE id = ?", [uuid(id, "Бронь")])[0] ?? null;
  }

  validateReservation(input, reservationId = null) {
    const propertyId = uuid(input.propertyId, "Дом");
    const property = this.getProperty(propertyId);
    if (!property || property.status !== "active") throw new Error("Выберите активный дом");
    const checkInDate = validDate(input.checkInDate, "Дата заезда");
    const checkOutDate = validDate(input.checkOutDate, "Дата выезда");
    const nights = eachNight(checkInDate, checkOutDate);
    // "stay" or "rental". Read before validation, because the kind decides which booking
    // window applies: a tenancy is exempt from the advance window, so judging it as a stay
    // would refuse an ordinary lease.
    const bookingKind = input.bookingKind === "rental" ? "rental" : "stay";
    const status = ALLOWED_RESERVATION_STATUSES.has(input.status) ? input.status : "hold";
    const depositStatus = ALLOWED_DEPOSIT_STATUSES.has(input.depositStatus) ? input.depositStatus : "none";
    const adults = integer(input.adults ?? 1, "Взрослые", 1, 100);
    const children = integer(input.children ?? 0, "Дети", 0, 100);
    const prepaidMinor = money(input.prepaidMinor, "Предоплата");
    const depositMinor = money(input.depositMinor, "Депозит");
    if (adults + children > property.capacity) {
      throw new Error(`Вместимость дома — ${property.capacity}. Уменьшите число гостей или выберите другой дом`);
    }
    const existing = reservationId ? this.getReservation(reservationId) : null;
    assertBookingDates({
      checkInDate,
      checkOutDate,
      today: this.todayProvider(),
      existingReservation: existing,
      // The account's window, as last reported by the server.
      //
      // Without this the client applies the compiled 21-day default regardless of what the
      // account is configured for, so an owner who widened the window would still be refused
      // locally while the server — which reads the real policy — would have accepted it. The
      // two have to judge by the same rule, or the client invents a limit the account does
      // not have.
      policy: this.bookingPolicy(),
      kind: bookingKind,
    });
    const actualCheckOutDate = existing?.actual_check_out_date || null;
    if (actualCheckOutDate && (actualCheckOutDate < checkInDate || actualCheckOutDate >= checkOutDate)) {
      throw new Error("После досрочного выезда даты проживания нельзя сдвинуть за фактическую дату выезда");
    }
    // Pricing. A tenancy is rent for whole calendar months; a stay is the nights it occupies.
    // They must not share an arithmetic path — multiplying a nightly rate by 365 produces a
    // number that looks like a year's rent and is not one — and both now go through the shared
    // quote, which also applies the unit's seasons and length discounts. The arithmetic itself
    // lives in src/domain/booking/pricing.cjs and is mirrored in Go, pinned by
    // fixtures/pricing-cases.json.
    const nightlyRateMinor = existing && existing.property_id === propertyId
      ? existing.nightly_rate_minor
      : property.base_price_minor;
    const monthlyRateMinor = existing && existing.property_id === propertyId && existing.monthly_rate_minor > 0
      ? existing.monthly_rate_minor
      : property.monthly_rate_minor || 0;

    // A negotiated amount is read first, because it replaces the computed figure entirely.
    // Checking the unit's rate before this would refuse a let that the owner has already
    // agreed a price for — the negotiated amount is the whole reason the field exists.
    const hasNegotiated = input.accommodationMinor !== undefined
      && input.accommodationMinor !== null
      && input.accommodationMinor !== "";

    // The unit's seasons and length discounts, as stored. A unit with none prices exactly as it
    // did before they existed, which is what lets this ship without repricing existing units.
    const quote = quoteReservation({
      kind: bookingKind,
      checkInDate,
      checkOutDate,
      baseNightlyRateMinor: nightlyRateMinor,
      monthlyRateMinor,
      rateRules: property.rate_rules,
    });

    let accommodationMinor;
    if (hasNegotiated) {
      accommodationMinor = money(input.accommodationMinor, "Сумма проживания");
    } else if (bookingKind === "rental") {
      if (quote.months < 1) {
        // Zero whole months would price the let at nothing, silently.
        throw new Error("Аренда не может быть короче одного календарного месяца");
      }
      if (!monthlyRateMinor) {
        throw new Error("Для аренды укажите месячную ставку объекта или сумму вручную");
      }
      accommodationMinor = quote.totalMinor;
    } else {
      accommodationMinor = quote.totalMinor;
    }
    // The working behind the amount, stored with the booking.
    //
    // It travels WITH the money rather than being recomputed on read: the unit's rules and rates
    // can change after the booking, and an invoice that re-derives a breakdown from today's
    // prices while showing the amount actually charged is worse than showing no breakdown.
    //
    //   - A stay cut short keeps the amount AND the breakdown it was invoiced at. Repricing to
    //     the nights kept is the early-checkout screen's job, not this one's.
    //   - A negotiated amount has no breakdown to store. Recording the computed one would put
    //     an arithmetic explanation next to a figure that was agreed, not calculated.
    let rateBreakdown = "{}";
    if (actualCheckOutDate) {
      accommodationMinor = existing.accommodation_minor;
      rateBreakdown = existing.rate_breakdown || "{}";
    } else if (!hasNegotiated) {
      rateBreakdown = JSON.stringify(quote);
    }
    const place = property.place_id ? this.getPlace(property.place_id) : null;
    if (!Array.isArray(input.mealItems ?? [])) {
      throw new Error("Питание: неверный формат данных");
    }
    if ((input.mealItems ?? []).length > 2190) {
      throw new Error("Питание: слишком много записей");
    }
    const effectiveNights = actualCheckOutDate
      ? nights.filter((night) => night < actualCheckOutDate)
      : nights;
    const allowedDates = new Set(effectiveNights);
    const mealKeys = new Set();
    const meals = (input.mealItems ?? []).map((item) => {
      const date = validDate(item.date, "Дата питания");
      const type = String(item.type ?? "");
      if (!ALLOWED_MEAL_TYPES.has(type)) throw new Error("Питание: неизвестный тип");
      const amountMinor = money(item.amountMinor ?? 0, "Сумма питания");
      return { date, type, amountMinor };
    }).filter((item) => item.amountMinor > 0);
    meals.forEach((item) => {
      if (!allowedDates.has(item.date)) {
        throw new Error(`Питание за ${item.date} находится вне фактических дат проживания`);
      }
      const key = `${item.date}:${item.type}`;
      if (mealKeys.has(key)) throw new Error(`Питание за ${item.date} указано повторно`);
      mealKeys.add(key);
    });
    const servicesMinor = meals.reduce((sum, item) => sum + item.amountMinor, 0);
    if (servicesMinor > 0 && !place?.has_food_service) {
      throw new Error("Для выбранного дома питание недоступно: включите кухню или ресторан в доме отдыха");
    }
    const totalMinor = accommodationMinor + servicesMinor;
    if (prepaidMinor > totalMinor) throw new Error("Предоплата не может быть больше общей стоимости брони");
    if (depositMinor === 0 && depositStatus !== "none") {
      throw new Error("Для статуса депозита укажите сумму или выберите «Не требуется»");
    }
    return {
      propertyId,
      guestName: requiredText(input.guestName, "Имя гостя", 160),
      guestPhone: normalizePhone(input.guestPhone),
      guestEmail: optionalText(input.guestEmail, 200),
      checkInDate,
      checkOutDate,
      nights,
      adults,
      children,
      status,
      bookingKind,
      monthlyRateMinor,
      // Meter readings are typed in per tenancy and stored as text. A malformed value
      // falls back to an empty object rather than failing the save: they are reference
      // data, and a typo in them must not lose the booking.
      meterReadings: normalizeMeterReadings(input.meterReadings),
      nightlyRateMinor,
      accommodationMinor,
      rateBreakdown,
      meals,
      servicesMinor,
      totalMinor,
      prepaidMinor,
      depositMinor,
      depositStatus,
      actualCheckOutDate,
      notes: optionalText(input.notes, 2000),
    };
  }

  insertNights(reservationId, data) {
    if (data.status === "cancelled" || data.status === "no_show") return;
    const timestamp = nowIso();
    const effectiveNights = data.actualCheckOutDate
      ? data.nights.filter((night) => night < data.actualCheckOutDate)
      : data.nights;
    effectiveNights.forEach((night) => {
      try {
        const nightId = crypto.randomUUID();
        this.run(
          `INSERT INTO reservation_nights(
            id, reservation_id, property_id, night_date, created_at, updated_at, version, last_writer
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          [nightId, reservationId, data.propertyId, night, timestamp, timestamp, this.writerId],
        );
        // Queue the night as well as the booking.
        //
        // `reservation_nights` is a synced table, so without this a lease reaches the server
        // with no nights. The other device then shows the unit as free for the whole term —
        // the tenancy exists but blocks nothing, which is the exact double-booking the shared
        // exclusion constraint exists to prevent. It went unnoticed because the reservation
        // itself synced fine and the local calendar reads the local rows.
        this.enqueueSync("reservation_nights", nightId);
      } catch (error) {
        if (/UNIQUE constraint failed/.test(error.message)) {
          const conflict = this.query(
            `SELECT r.id, r.guest_name, p.name AS property_name
             FROM reservation_nights rn
             JOIN reservations r ON r.id = rn.reservation_id
             JOIN properties p ON p.id = rn.property_id
             WHERE rn.property_id = ? AND rn.night_date = ?`,
            [data.propertyId, night],
          )[0];
          throw new Error(
            `Дом «${conflict?.property_name ?? "выбранный"}» уже занят ${night}` +
            (conflict ? ` (бронь №${conflict.id}, ${conflict.guest_name})` : ""),
          );
        }
        throw error;
      }
    });
  }

  replaceReservationMeals(reservationId, meals) {
    const timestamp = nowIso();
    this.run("DELETE FROM reservation_meals WHERE reservation_id = ?", [reservationId]);
    meals.forEach((item) => this.run(
      `INSERT INTO reservation_meals(
        id, reservation_id, meal_date, meal_type, amount_minor, created_at, updated_at, version, last_writer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [crypto.randomUUID(), reservationId, item.date, item.type, item.amountMinor, timestamp, timestamp, this.writerId],
    ));
  }

  createReservation(input) {
    const data = this.validateReservation(input);
    const timestamp = nowIso();
    return this.transaction(() => {
      const id = crypto.randomUUID();
      this.run(
        `INSERT INTO reservations(
          id, property_id, guest_name, guest_phone, guest_email, check_in_date, check_out_date,
          adults, children, status, booking_kind, monthly_rate_minor, meter_readings,
          nightly_rate_minor, accommodation_minor, rate_breakdown, services_minor,
          total_minor, prepaid_minor, deposit_minor, deposit_status, notes, created_at, updated_at,
          version, last_writer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          id, data.propertyId, data.guestName, data.guestPhone, data.guestEmail,
          data.checkInDate, data.checkOutDate, data.adults, data.children, data.status,
          data.bookingKind, data.monthlyRateMinor, data.meterReadings,
          data.nightlyRateMinor, data.accommodationMinor, data.rateBreakdown, data.servicesMinor,
          data.totalMinor, data.prepaidMinor, data.depositMinor, data.depositStatus,
          data.notes, timestamp, timestamp, this.writerId,
        ],
      );
      this.insertNights(id, data);
      this.replaceReservationMeals(id, data.meals);
      this.enqueueSync("reservations", id);
      this.audit("reservation", id, "created", data);
      return this.getReservation(id);
    });
  }

  updateReservation(id, input) {
    const reservationId = uuid(id, "Бронь");
    if (!this.getReservation(reservationId)) throw new Error("Бронь не найдена");
    const data = this.validateReservation(input, reservationId);
    return this.transaction(() => {
      this.run("DELETE FROM reservation_nights WHERE reservation_id = ?", [reservationId]);
      this.run(
        `UPDATE reservations SET
          property_id = ?, guest_name = ?, guest_phone = ?, guest_email = ?,
          check_in_date = ?, check_out_date = ?, adults = ?, children = ?, status = ?,
          nightly_rate_minor = ?, accommodation_minor = ?, rate_breakdown = ?, services_minor = ?,
          total_minor = ?, prepaid_minor = ?, deposit_minor = ?, deposit_status = ?,
          actual_check_out_date = ?,
          notes = ?, updated_at = ?, version = version + 1, last_writer = ?
        WHERE id = ?`,
        [
          data.propertyId, data.guestName, data.guestPhone, data.guestEmail,
          data.checkInDate, data.checkOutDate, data.adults, data.children, data.status,
          data.nightlyRateMinor, data.accommodationMinor, data.rateBreakdown, data.servicesMinor,
          data.totalMinor, data.prepaidMinor, data.depositMinor, data.depositStatus,
          data.actualCheckOutDate, data.notes, nowIso(), this.writerId, reservationId,
        ],
      );
      this.insertNights(reservationId, data);
      this.replaceReservationMeals(reservationId, data.meals);
      this.enqueueSync("reservations", reservationId);
      this.audit("reservation", reservationId, "updated", data);
      return this.getReservation(reservationId);
    });
  }

  cancelReservation(id) {
    const reservationId = uuid(id, "Бронь");
    if (!this.getReservation(reservationId)) throw new Error("Бронь не найдена");
    return this.transaction(() => {
      this.run("DELETE FROM reservation_nights WHERE reservation_id = ?", [reservationId]);
      this.run(
        "UPDATE reservations SET status = 'cancelled', updated_at = ?, version = version + 1, last_writer = ? WHERE id = ?",
        [nowIso(), this.writerId, reservationId],
      );
      this.enqueueSync("reservations", reservationId);
      this.audit("reservation", reservationId, "cancelled");
      return this.getReservation(reservationId);
    });
  }

  deleteReservation(id) {
    const reservationId = uuid(id, "Бронь");
    const reservation = this.getReservation(reservationId);
    if (!reservation) throw new Error("Бронь не найдена");
    if (!["cancelled", "no_show", "checked_out"].includes(reservation.status)) {
      throw new Error("Сначала отмените активную бронь, затем удалите её из истории");
    }
    return this.transaction(() => {
      this.audit("reservation", reservationId, "deleted", {
        propertyId: reservation.property_id,
        guestName: reservation.guest_name,
        checkInDate: reservation.check_in_date,
        checkOutDate: reservation.check_out_date,
        status: reservation.status,
        totalMinor: reservation.total_minor,
        prepaidMinor: reservation.prepaid_minor,
        depositMinor: reservation.deposit_minor,
      });
      this.run("DELETE FROM reservations WHERE id = ?", [reservationId]);
      return true;
    });
  }

  earlyCheckout(id, input) {
    const reservationId = uuid(id, "Бронь");
    const reservation = this.getReservation(reservationId);
    if (!reservation) throw new Error("Бронь не найдена");
    if (!["confirmed", "checked_in", "hold"].includes(reservation.status)) {
      throw new Error("Досрочный выезд доступен только для активной брони");
    }
    const actualDate = validDate(input.actualCheckOutDate, "Фактическая дата выезда");
    if (actualDate < reservation.check_in_date || actualDate >= reservation.check_out_date) {
      throw new Error("Фактический выезд должен быть от даты заезда до плановой даты выезда");
    }
    const recalculate = input.billingPolicy !== "keep_total";
    const usedNights = actualDate === reservation.check_in_date
      ? 0
      : eachNight(reservation.check_in_date, actualDate).length;
    return this.transaction(() => {
      this.run("DELETE FROM reservation_nights WHERE reservation_id = ? AND night_date >= ?", [reservationId, actualDate]);
      this.run("DELETE FROM reservation_meals WHERE reservation_id = ? AND meal_date >= ?", [reservationId, actualDate]);
      // Repriced through the same quote the booking was created with, so a stay that ends early
      // is charged the seasons and discounts its shortened dates actually earn — nights x rate
      // ignored both, and charged a peak-week rate for a week the guest did not stay.
      //
      // A TENANCY is repriced by whole months elapsed rather than by nights: multiplying a
      // monthly rate by a night count produces a number that looks like rent and is not one.
      // The elapsed count floors at one month, because a tenancy that has begun has begun.
      const property = this.getProperty(reservation.property_id);
      const shortened = reservation.booking_kind === "rental"
        ? quoteTenancy({
          months: Math.max(1, wholeMonthsBetween(reservation.check_in_date, actualDate)),
          monthlyRateMinor: reservation.monthly_rate_minor,
          rateRules: property?.rate_rules,
        })
        : quoteReservation({
          kind: "stay",
          checkInDate: reservation.check_in_date,
          checkOutDate: actualDate,
          baseNightlyRateMinor: reservation.nightly_rate_minor,
          rateRules: property?.rate_rules,
        });
      const accommodationMinor = recalculate ? shortened.totalMinor : reservation.accommodation_minor;
      const rateBreakdown = recalculate ? JSON.stringify(shortened) : (reservation.rate_breakdown || "{}");
      const servicesMinor = Number(this.scalar(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM reservation_meals WHERE reservation_id = ?",
        [reservationId],
      ) || 0);
      const totalMinor = accommodationMinor + servicesMinor;
      this.run(
        `UPDATE reservations SET status = 'checked_out', actual_check_out_date = ?,
          accommodation_minor = ?, rate_breakdown = ?, services_minor = ?, total_minor = ?,
          updated_at = ?, version = version + 1, last_writer = ? WHERE id = ?`,
        [actualDate, accommodationMinor, rateBreakdown, servicesMinor, totalMinor, nowIso(), this.writerId, reservationId],
      );
      this.audit("reservation", reservationId, "early_checkout", {
        actualCheckOutDate: actualDate,
        billingPolicy: recalculate ? "recalculate" : "keep_total",
        usedNights,
        accommodationMinor,
        servicesMinor,
        totalMinor,
      });
      return this.listReservations().find((item) => item.id === reservationId);
    });
  }

  dashboard() {
    const today = todayIso();
    const activeProperties = Number(this.scalar("SELECT COUNT(*) FROM properties WHERE status = 'active'") || 0);
    const activeReservations = Number(this.scalar(
      "SELECT COUNT(*) FROM reservations WHERE status IN ('hold','confirmed','checked_in') AND check_out_date >= ?",
      [today],
    ) || 0);
    const expectedMinor = Number(this.scalar(
      `SELECT COALESCE(SUM(CASE WHEN total_minor > prepaid_minor THEN total_minor - prepaid_minor ELSE 0 END), 0)
       FROM reservations
       WHERE status IN ('hold','confirmed','checked_in')`,
    ) || 0);
    const refundsDueMinor = Number(this.scalar(
      `SELECT COALESCE(SUM(CASE WHEN prepaid_minor > total_minor THEN prepaid_minor - total_minor ELSE 0 END), 0)
       FROM reservations WHERE status = 'checked_out'`,
    ) || 0);
    const depositsHeldMinor = Number(this.scalar(
      `SELECT COALESCE(SUM(deposit_minor), 0)
       FROM reservations
       WHERE deposit_status IN ('received','partially_withheld')`,
    ) || 0);
    const arrivals = this.query(
      `SELECT r.*, p.name AS property_name, pl.name AS place_name
       FROM reservations r JOIN properties p ON p.id = r.property_id
       LEFT JOIN places pl ON pl.id = p.place_id
       WHERE r.check_in_date = ? AND r.status NOT IN ('cancelled','no_show')
       ORDER BY p.name`,
      [today],
    );
    const departures = this.query(
      `SELECT r.*, p.name AS property_name, pl.name AS place_name
       FROM reservations r JOIN properties p ON p.id = r.property_id
       LEFT JOIN places pl ON pl.id = p.place_id
       WHERE r.check_out_date = ? AND r.status NOT IN ('cancelled','no_show')
       ORDER BY p.name`,
      [today],
    );
    return { today, activeProperties, activeReservations, expectedMinor, refundsDueMinor, depositsHeldMinor, arrivals, departures };
  }

  /**
   * The occupancy grid for a window of days.
   *
   * `startDate` is what makes the calendar navigable: without it the window always began today,
   * so "previous period" could only ever have shown the same two weeks. It is an ISO date rather
   * than an offset so that a window means the same dates on every device and in a bookmark,
   * instead of shifting with whatever "today" happens to be when it is read.
   *
   * Defaults to today, which keeps every existing caller — and anything holding a stored window —
   * working unchanged.
   */
  calendar(days = 14, startDate = null) {
    const safeDays = integer(days, "Период календаря", 7, 60);
    // `this.todayProvider`, not the module clock: the account's time zone (and a test's idea of
    // today) decide the window, the same way they decide every other date in the domain.
    const from = startDate ? validDate(startDate, "Начало периода") : this.todayProvider();
    const start = new Date(`${from}T00:00:00Z`);
    const dates = Array.from({ length: safeDays }, (_, index) =>
      new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    );
    const properties = this.listProperties({ includeArchived: false });
    const occupancy = this.query(
      `SELECT rn.property_id, rn.night_date, r.id AS reservation_id, r.guest_name, r.status
       FROM reservation_nights rn
       JOIN reservations r ON r.id = rn.reservation_id
       WHERE rn.night_date >= ? AND rn.night_date < ?
       ORDER BY rn.night_date`,
      [dates[0], new Date(start.getTime() + safeDays * 86_400_000).toISOString().slice(0, 10)],
    );
    // `startDate` is echoed back: the renderer asked for a window and gets to know which one it
    // received, rather than recomputing it and drifting a day on a timezone boundary.
    return { dates, startDate: dates[0], properties, occupancy };
  }

  createBackup() {
    this.persist();
    const stamp = nowIso().replace(/[:.]/g, "-");
    // The backup is named after the product the user knows. It is a file THEY see and
    // may copy elsewhere, unlike the database filename beside it, which is kept as
    // dombook.sqlite because renaming it would orphan every existing install (AGENTS.md).
    const backupPath = path.join(this.backupDir, `rentkeeper-${stamp}.sqlite`);
    fs.copyFileSync(this.filePath, backupPath);
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
    this.audit("backup", null, "created", { file: path.basename(backupPath), checksum });
    const removed = this.pruneBackups();
    this.persist();
    return { file: path.basename(backupPath), path: backupPath, checksum, createdAt: nowIso(), removed };
  }

  /**
   * Keep the newest BACKUP_LIMIT copies and delete the rest.
   *
   * Nothing removed old backups, and each one is a full copy of the database. A daily backup on a
   * database that grows is a disk that fills quietly, and the failure arrives as a write error in
   * the middle of somebody's booking rather than as anything that mentions backups.
   *
   * A LIMIT, not a size budget: the number of files is what an owner can reason about, and the
   * newest ten are the ones a bad week is recovered from. Documents are deliberately NOT covered
   * by this. A contract is a legal record and deleting one automatically would trade a few
   * hundred kilobytes for the paper a tax inspection asks for, which is the wrong trade at any
   * size (AGENTS.md records the same reasoning for the documents folder).
   */
  pruneBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    const files = fs.readdirSync(this.backupDir)
      .filter((name) => /^rentkeeper-.*\.sqlite$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(this.backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const doomed = files.slice(BACKUP_LIMIT);
    for (const entry of doomed) {
      try {
        fs.rmSync(path.join(this.backupDir, entry.name));
      } catch {
        // A backup that cannot be removed is not a reason to fail the backup that was just made.
      }
    }
    if (doomed.length) {
      this.audit("backup", null, "pruned", { files: doomed.map((entry) => entry.name) });
    }
    return doomed.map((entry) => entry.name);
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => {
        const fullPath = path.join(this.backupDir, name);
        const stats = fs.statSync(fullPath);
        return { file: name, path: fullPath, size: stats.size, createdAt: stats.birthtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  systemInfo() {
    return {
      databasePath: this.filePath,
      backupDir: this.backupDir,
      databaseSize: fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0,
      // Reported from the cached server policy so the UI shows the account's real window.
      bookingPolicy: bookingLimits(null, this.todayProvider(), this.bookingPolicy()),
      language: this.getLanguage(),
      documentRequisites: this.documentRequisites(),
    };
  }

  /**
   * The details a contract or an invoice has to carry to be worth anything to an accountant.
   *
   * Stored as one JSON blob in app_settings rather than as columns on an `accounts` row: the set
   * of requisites a jurisdiction wants varies (VÖEN here, ИНН and КПП a border away), and a schema
   * with one column per field would need a migration for every country the product is sold in.
   * app_settings already replicates, so the details reach every device the owner signs in on.
   *
   * Read tolerantly: a half-filled or unreadable value must degrade to "not filled in yet" so the
   * document can still be produced with blank lines, rather than failing the generation.
   */
  documentRequisites() {
    const fallback = {
      lessorName: "",
      lessorTaxId: "",
      lessorAddress: "",
      lessorPhone: "",
      bankDetails: "",
      signatoryName: "",
      documentCity: "",
    };
    const stored = this.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'document_requisites'",
    );
    if (!stored) return fallback;
    try {
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object") return fallback;
      return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [
        key,
        typeof parsed[key] === "string" ? parsed[key].trim().slice(0, 300) : value,
      ]));
    } catch {
      return fallback;
    }
  }

  setDocumentRequisites(input) {
    const current = this.documentRequisites();
    const next = Object.fromEntries(Object.entries(current).map(([key, value]) => [
      key,
      typeof input?.[key] === "string" ? input[key].trim().slice(0, 300) : value,
    ]));
    this.upsertSetting("document_requisites", JSON.stringify(next));
    // Persisted here for the same reason setBookingPolicy does it: upsertSetting only writes to
    // the in-memory database, and requisites that vanish on restart would have to be retyped
    // before every contract.
    this.persist();
    return next;
  }

  getLanguage() {
    const language = this.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'interface_language'",
    );
    return ALLOWED_INTERFACE_LANGUAGES.has(language) ? language : "ru";
  }

  upsertSetting(key, value) {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO app_settings(id, setting_key, setting_value, created_at, updated_at, version, last_writer)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at,
         version = version + 1,
         last_writer = excluded.last_writer`,
      [crypto.randomUUID(), key, value, timestamp, timestamp, this.writerId],
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
    const stored = this.query("SELECT id FROM app_settings WHERE setting_key = ?", [key])[0];
    if (stored) this.enqueueSync("app_settings", stored.id);
  }

  setLanguage(language) {
    const normalized = String(language ?? "").trim().toLowerCase();
    if (!ALLOWED_INTERFACE_LANGUAGES.has(normalized)) {
      throw new Error("Доступные языки интерфейса: ru, az, en");
    }
    this.upsertSetting("interface_language", normalized);
    this.audit("settings", null, "language_changed", { language: normalized });
    this.persist();
    return normalized;
  }

  close() {
    if (!this.db) return;
    this.persist();
    this.db.close();
    this.db = null;
  }
}

module.exports = {
  nowIso,
  RentKeeperDatabase,
  eachNight,
};

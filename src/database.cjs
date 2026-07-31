const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const initSqlJs = require("sql.js");
const {
  assertBookingDates,
  bookingLimits,
  todayInTimeZone,
} = require("./domain/booking/booking-policy.cjs");

const ALLOWED_RESERVATION_STATUSES = new Set([
  "hold",
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
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

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return todayInTimeZone();
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

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label}: укажите целое число от ${min} до ${max}`);
  }
  return result;
}

function money(value, label) {
  return integer(value, label, 0, 1_000_000_000);
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

function rowsFrom(result) {
  if (!result?.length) return [];
  const [{ columns, values }] = result;
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

class DomBookDatabase {
  constructor({ filePath, backupDir, seed = true, todayProvider = todayInTimeZone }) {
    this.filePath = filePath;
    this.backupDir = backupDir;
    this.seed = seed;
    this.todayProvider = todayProvider;
    this.db = null;
    this.SQL = null;
  }

  async init() {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    this.SQL = await initSqlJs({ locateFile: () => wasmPath });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });

    if (fs.existsSync(this.filePath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.filePath));
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
    if (this.seed) this.seedDemoData();
    this.persist();
    return this;
  }

  migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS places (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        address TEXT NOT NULL DEFAULT '',
        has_food_service INTEGER NOT NULL DEFAULT 0 CHECK(has_food_service IN (0, 1)),
        breakfast_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(breakfast_price_minor >= 0),
        lunch_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(lunch_price_minor >= 0),
        dinner_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(dinner_price_minor >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS properties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        place_id INTEGER REFERENCES places(id),
        kind TEXT NOT NULL DEFAULT 'house' CHECK(kind IN ('cottage', 'house')),
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        location TEXT NOT NULL DEFAULT '',
        capacity INTEGER NOT NULL CHECK(capacity > 0),
        base_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(base_price_minor >= 0),
        deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK(deposit_minor >= 0),
        currency TEXT NOT NULL DEFAULT 'AZN',
        check_in_time TEXT NOT NULL DEFAULT '15:00',
        check_out_time TEXT NOT NULL DEFAULT '11:00',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        guest_name TEXT NOT NULL,
        guest_phone TEXT NOT NULL DEFAULT '',
        guest_email TEXT NOT NULL DEFAULT '',
        check_in_date TEXT NOT NULL,
        check_out_date TEXT NOT NULL,
        adults INTEGER NOT NULL DEFAULT 1 CHECK(adults > 0),
        children INTEGER NOT NULL DEFAULT 0 CHECK(children >= 0),
        status TEXT NOT NULL CHECK(status IN ('hold','confirmed','checked_in','checked_out','cancelled','no_show')),
        nightly_rate_minor INTEGER NOT NULL DEFAULT 0 CHECK(nightly_rate_minor >= 0),
        accommodation_minor INTEGER NOT NULL DEFAULT 0 CHECK(accommodation_minor >= 0),
        services_minor INTEGER NOT NULL DEFAULT 0 CHECK(services_minor >= 0),
        total_minor INTEGER NOT NULL DEFAULT 0 CHECK(total_minor >= 0),
        prepaid_minor INTEGER NOT NULL DEFAULT 0 CHECK(prepaid_minor >= 0),
        deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK(deposit_minor >= 0),
        deposit_status TEXT NOT NULL DEFAULT 'none' CHECK(deposit_status IN ('none','due','received','returned','partially_withheld','withheld')),
        actual_check_out_date TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservation_nights (
        reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        night_date TEXT NOT NULL,
        PRIMARY KEY(property_id, night_date)
      );

      CREATE TABLE IF NOT EXISTS reservation_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        service_type TEXT NOT NULL CHECK(service_type IN ('breakfast','lunch','dinner')),
        service_name TEXT NOT NULL,
        unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        UNIQUE(reservation_id, service_type)
      );

      CREATE TABLE IF NOT EXISTS reservation_meals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        meal_date TEXT NOT NULL,
        meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast','lunch','dinner')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        UNIQUE(reservation_id, meal_date, meal_type)
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS reservations_dates_idx
        ON reservations(check_in_date, check_out_date);
      CREATE INDEX IF NOT EXISTS reservations_property_idx
        ON reservations(property_id, status);
      CREATE INDEX IF NOT EXISTS properties_place_idx
        ON properties(place_id, status);
      CREATE INDEX IF NOT EXISTS audit_created_idx
        ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS reservation_meals_reservation_date_idx
        ON reservation_meals(reservation_id, meal_date);
    `);

    this.ensureColumn("places", "has_food_service", "INTEGER NOT NULL DEFAULT 0 CHECK(has_food_service IN (0, 1))");
    this.ensureColumn("places", "breakfast_price_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(breakfast_price_minor >= 0)");
    this.ensureColumn("places", "lunch_price_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(lunch_price_minor >= 0)");
    this.ensureColumn("places", "dinner_price_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(dinner_price_minor >= 0)");
    this.ensureColumn("reservations", "nightly_rate_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(nightly_rate_minor >= 0)");
    this.ensureColumn("reservations", "accommodation_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(accommodation_minor >= 0)");
    this.ensureColumn("reservations", "services_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(services_minor >= 0)");
    this.ensureColumn("reservations", "actual_check_out_date", "TEXT");
    this.db.run(`
      UPDATE reservations
      SET accommodation_minor = total_minor
      WHERE accommodation_minor = 0 AND services_minor = 0 AND total_minor > 0;
      UPDATE reservations
      SET nightly_rate_minor = CASE
        WHEN julianday(check_out_date) > julianday(check_in_date)
          THEN CAST(accommodation_minor / (julianday(check_out_date) - julianday(check_in_date)) AS INTEGER)
        ELSE accommodation_minor
      END
      WHERE nightly_rate_minor = 0 AND accommodation_minor > 0;
    `);

    if (!this.scalar("SELECT 1 FROM schema_migrations WHERE name = 'daily_meals_v1'")) {
      this.db.run(`
        INSERT OR IGNORE INTO reservation_meals(reservation_id, meal_date, meal_type, amount_minor)
        SELECT rs.reservation_id, r.check_in_date, rs.service_type,
          SUM(rs.unit_price_minor * rs.quantity)
        FROM reservation_services rs
        JOIN reservations r ON r.id = rs.reservation_id
        GROUP BY rs.reservation_id, r.check_in_date, rs.service_type
        HAVING SUM(rs.unit_price_minor * rs.quantity) > 0;

        INSERT OR IGNORE INTO reservation_meals(reservation_id, meal_date, meal_type, amount_minor)
        SELECT r.id, r.check_in_date, 'lunch', r.services_minor
        FROM reservations r
        WHERE r.services_minor > 0
          AND NOT EXISTS (
            SELECT 1 FROM reservation_meals rm WHERE rm.reservation_id = r.id
          );
      `);
      this.run(
        "INSERT INTO schema_migrations(name, applied_at) VALUES ('daily_meals_v1', ?)",
        [nowIso()],
      );
    }
  }

  ensureColumn(table, column, definition) {
    const exists = this.query(`PRAGMA table_info(${table})`).some((item) => item.name === column);
    if (!exists) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  seedDemoData() {
    const count = this.scalar("SELECT COUNT(*) FROM properties");
    if (count > 0) return;

    const place = this.createPlace(
      { name: "Дом отдыха «Лесная долина»", address: "Габала", notes: "Демонстрационный комплекс" },
      { persist: false, audit: false },
    );
    const houses = [
      { name: "Коттедж «Сосны»", kind: "cottage", placeId: place.id, location: "", capacity: 6, basePriceMinor: 24000, depositMinor: 30000, notes: "Тихий коттедж рядом с лесом" },
      { name: "Коттедж «У озера»", kind: "cottage", placeId: place.id, location: "", capacity: 8, basePriceMinor: 32000, depositMinor: 40000, notes: "Большая терраса и вид на воду" },
      { name: "Отдельный дом в Шеки", kind: "house", placeId: null, location: "Шеки", capacity: 3, basePriceMinor: 17000, depositMinor: 20000, notes: "Самостоятельный дом для пары" },
    ];
    houses.forEach((house) => this.createProperty(house, { persist: false, audit: false }));
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
    return Number(this.scalar("SELECT last_insert_rowid()"));
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
    this.run(
      "INSERT INTO audit_log(entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [entityType, entityId ?? null, action, JSON.stringify(payload), nowIso()],
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
    return this.query("SELECT * FROM places WHERE id = ?", [integer(id, "Дом отдыха", 1)])[0] ?? null;
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
      const id = this.run(
        `INSERT INTO places(
          name, address, has_food_service, breakfast_price_minor, lunch_price_minor,
          dinner_price_minor, status, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.name, data.address, data.hasFoodService, data.breakfastPriceMinor, data.lunchPriceMinor,
          data.dinnerPriceMinor, data.status, data.notes, timestamp, timestamp],
      );
      if (options.audit !== false) this.audit("place", id, "created", data);
      return this.getPlace(id);
    };
    if (options.persist === false) return create();
    return this.transaction(create);
  }

  updatePlace(id, input) {
    const placeId = integer(id, "Дом отдыха", 1);
    if (!this.getPlace(placeId)) throw new Error("Дом отдыха не найден");
    const data = this.validatePlace(input);
    return this.transaction(() => {
      const duplicate = this.listPlaces().find(
        (place) => place.id !== placeId && canonicalName(place.name) === canonicalName(data.name),
      );
      if (duplicate) throw new Error("Дом отдыха с таким названием уже существует");
      this.run(
        `UPDATE places SET name = ?, address = ?, has_food_service = ?, breakfast_price_minor = ?,
          lunch_price_minor = ?, dinner_price_minor = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`,
        [data.name, data.address, data.hasFoodService, data.breakfastPriceMinor, data.lunchPriceMinor,
          data.dinnerPriceMinor, data.status, data.notes, nowIso(), placeId],
      );
      this.audit("place", placeId, "updated", data);
      return this.getPlace(placeId);
    });
  }

  archivePlace(id) {
    const placeId = integer(id, "Дом отдыха", 1);
    if (!this.getPlace(placeId)) throw new Error("Дом отдыха не найден");
    return this.transaction(() => {
      this.run("UPDATE places SET status = 'archived', updated_at = ? WHERE id = ?", [nowIso(), placeId]);
      this.audit("place", placeId, "archived");
      return this.getPlace(placeId);
    });
  }

  restorePlace(id) {
    const placeId = integer(id, "Дом отдыха", 1);
    if (!this.getPlace(placeId)) throw new Error("Дом отдыха не найден");
    return this.transaction(() => {
      this.run("UPDATE places SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), placeId]);
      this.audit("place", placeId, "restored");
      return this.getPlace(placeId);
    });
  }

  getProperty(id) {
    return this.query("SELECT * FROM properties WHERE id = ?", [integer(id, "Дом", 1)])[0] ?? null;
  }

  validateProperty(input) {
    const placeId = input.placeId === null || input.placeId === "" || input.placeId === undefined
      ? null
      : integer(input.placeId, "Дом отдыха", 1);
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
      depositMinor: money(input.depositMinor, "Депозит"),
      currency: requiredText(input.currency || "AZN", "Валюта", 3).toUpperCase(),
      checkInTime: requiredText(input.checkInTime || "15:00", "Время заезда", 5),
      checkOutTime: requiredText(input.checkOutTime || "11:00", "Время выезда", 5),
      notes: optionalText(input.notes, 2000),
      status: input.status === "archived" ? "archived" : "active",
    };
  }

  createProperty(input, options = {}) {
    const data = this.validateProperty(input);
    const timestamp = nowIso();
    const create = () => {
      const duplicate = this.listProperties().find(
        (property) => canonicalName(property.name) === canonicalName(data.name),
      );
      if (duplicate) throw new Error("Объект с таким наименованием уже существует");
      const id = this.run(
        `INSERT INTO properties(
          place_id, kind, name, location, capacity, base_price_minor, deposit_minor, currency,
          check_in_time, check_out_time, status, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.placeId, data.kind, data.name, data.location, data.capacity, data.basePriceMinor, data.depositMinor,
          data.currency, data.checkInTime, data.checkOutTime, data.status, data.notes,
          timestamp, timestamp,
        ],
      );
      if (options.audit !== false) this.audit("property", id, "created", data);
      return this.getProperty(id);
    };
    if (options.persist === false) return create();
    return this.transaction(create);
  }

  updateProperty(id, input) {
    const propertyId = integer(id, "Дом", 1);
    if (!this.getProperty(propertyId)) throw new Error("Дом не найден");
    const data = this.validateProperty(input);
    return this.transaction(() => {
      const duplicate = this.listProperties().find(
        (property) => property.id !== propertyId && canonicalName(property.name) === canonicalName(data.name),
      );
      if (duplicate) throw new Error("Объект с таким наименованием уже существует");
      this.run(
        `UPDATE properties SET
          place_id = ?, kind = ?, name = ?, location = ?, capacity = ?, base_price_minor = ?, deposit_minor = ?,
          currency = ?, check_in_time = ?, check_out_time = ?, status = ?, notes = ?,
          updated_at = ?
        WHERE id = ?`,
        [
          data.placeId, data.kind, data.name, data.location, data.capacity, data.basePriceMinor, data.depositMinor,
          data.currency, data.checkInTime, data.checkOutTime, data.status, data.notes,
          nowIso(), propertyId,
        ],
      );
      this.audit("property", propertyId, "updated", data);
      return this.getProperty(propertyId);
    });
  }

  archiveProperty(id) {
    const propertyId = integer(id, "Дом", 1);
    if (!this.getProperty(propertyId)) throw new Error("Дом не найден");
    return this.transaction(() => {
      this.run("UPDATE properties SET status = 'archived', updated_at = ? WHERE id = ?", [nowIso(), propertyId]);
      this.audit("property", propertyId, "archived");
      return this.getProperty(propertyId);
    });
  }

  restoreProperty(id) {
    const propertyId = integer(id, "Дом", 1);
    if (!this.getProperty(propertyId)) throw new Error("Дом не найден");
    return this.transaction(() => {
      this.run("UPDATE properties SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), propertyId]);
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
      ORDER BY r.check_in_date DESC, r.id DESC
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
    return this.query("SELECT * FROM reservations WHERE id = ?", [integer(id, "Бронь", 1)])[0] ?? null;
  }

  validateReservation(input, reservationId = null) {
    const propertyId = integer(input.propertyId, "Дом", 1);
    const property = this.getProperty(propertyId);
    if (!property || property.status !== "active") throw new Error("Выберите активный дом");
    const checkInDate = validDate(input.checkInDate, "Дата заезда");
    const checkOutDate = validDate(input.checkOutDate, "Дата выезда");
    const nights = eachNight(checkInDate, checkOutDate);
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
    });
    const actualCheckOutDate = existing?.actual_check_out_date || null;
    if (actualCheckOutDate && (actualCheckOutDate < checkInDate || actualCheckOutDate >= checkOutDate)) {
      throw new Error("После досрочного выезда даты проживания нельзя сдвинуть за фактическую дату выезда");
    }
    const nightlyRateMinor = existing && existing.property_id === propertyId
      ? existing.nightly_rate_minor
      : property.base_price_minor;
    const accommodationMinor = actualCheckOutDate
      ? existing.accommodation_minor
      : nightlyRateMinor * nights.length;
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
      nightlyRateMinor,
      accommodationMinor,
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
    const effectiveNights = data.actualCheckOutDate
      ? data.nights.filter((night) => night < data.actualCheckOutDate)
      : data.nights;
    effectiveNights.forEach((night) => {
      try {
        this.run(
          "INSERT INTO reservation_nights(reservation_id, property_id, night_date) VALUES (?, ?, ?)",
          [reservationId, data.propertyId, night],
        );
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
    this.run("DELETE FROM reservation_meals WHERE reservation_id = ?", [reservationId]);
    meals.forEach((item) => this.run(
      `INSERT INTO reservation_meals(
        reservation_id, meal_date, meal_type, amount_minor
      ) VALUES (?, ?, ?, ?)`,
      [reservationId, item.date, item.type, item.amountMinor],
    ));
  }

  createReservation(input) {
    const data = this.validateReservation(input);
    const timestamp = nowIso();
    return this.transaction(() => {
      const id = this.run(
        `INSERT INTO reservations(
          property_id, guest_name, guest_phone, guest_email, check_in_date, check_out_date,
          adults, children, status, nightly_rate_minor, accommodation_minor, services_minor,
          total_minor, prepaid_minor, deposit_minor, deposit_status, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.propertyId, data.guestName, data.guestPhone, data.guestEmail,
          data.checkInDate, data.checkOutDate, data.adults, data.children, data.status,
          data.nightlyRateMinor, data.accommodationMinor, data.servicesMinor,
          data.totalMinor, data.prepaidMinor, data.depositMinor, data.depositStatus,
          data.notes, timestamp, timestamp,
        ],
      );
      this.insertNights(id, data);
      this.replaceReservationMeals(id, data.meals);
      this.audit("reservation", id, "created", data);
      return this.getReservation(id);
    });
  }

  updateReservation(id, input) {
    const reservationId = integer(id, "Бронь", 1);
    if (!this.getReservation(reservationId)) throw new Error("Бронь не найдена");
    const data = this.validateReservation(input, reservationId);
    return this.transaction(() => {
      this.run("DELETE FROM reservation_nights WHERE reservation_id = ?", [reservationId]);
      this.run(
        `UPDATE reservations SET
          property_id = ?, guest_name = ?, guest_phone = ?, guest_email = ?,
          check_in_date = ?, check_out_date = ?, adults = ?, children = ?, status = ?,
          nightly_rate_minor = ?, accommodation_minor = ?, services_minor = ?,
          total_minor = ?, prepaid_minor = ?, deposit_minor = ?, deposit_status = ?,
          actual_check_out_date = ?,
          notes = ?, updated_at = ?
        WHERE id = ?`,
        [
          data.propertyId, data.guestName, data.guestPhone, data.guestEmail,
          data.checkInDate, data.checkOutDate, data.adults, data.children, data.status,
          data.nightlyRateMinor, data.accommodationMinor, data.servicesMinor,
          data.totalMinor, data.prepaidMinor, data.depositMinor, data.depositStatus,
          data.actualCheckOutDate, data.notes, nowIso(), reservationId,
        ],
      );
      this.insertNights(reservationId, data);
      this.replaceReservationMeals(reservationId, data.meals);
      this.audit("reservation", reservationId, "updated", data);
      return this.getReservation(reservationId);
    });
  }

  cancelReservation(id) {
    const reservationId = integer(id, "Бронь", 1);
    if (!this.getReservation(reservationId)) throw new Error("Бронь не найдена");
    return this.transaction(() => {
      this.run("DELETE FROM reservation_nights WHERE reservation_id = ?", [reservationId]);
      this.run("UPDATE reservations SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), reservationId]);
      this.audit("reservation", reservationId, "cancelled");
      return this.getReservation(reservationId);
    });
  }

  deleteReservation(id) {
    const reservationId = integer(id, "Бронь", 1);
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
    const reservationId = integer(id, "Бронь", 1);
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
      const accommodationMinor = recalculate
        ? reservation.nightly_rate_minor * usedNights
        : reservation.accommodation_minor;
      const servicesMinor = Number(this.scalar(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM reservation_meals WHERE reservation_id = ?",
        [reservationId],
      ) || 0);
      const totalMinor = accommodationMinor + servicesMinor;
      this.run(
        `UPDATE reservations SET status = 'checked_out', actual_check_out_date = ?,
          accommodation_minor = ?, services_minor = ?, total_minor = ?, updated_at = ? WHERE id = ?`,
        [actualDate, accommodationMinor, servicesMinor, totalMinor, nowIso(), reservationId],
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

  calendar(days = 14) {
    const safeDays = integer(days, "Период календаря", 7, 60);
    const start = new Date(`${todayIso()}T00:00:00Z`);
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
    return { dates, properties, occupancy };
  }

  createBackup() {
    this.persist();
    const stamp = nowIso().replace(/[:.]/g, "-");
    const backupPath = path.join(this.backupDir, `dombook-${stamp}.sqlite`);
    fs.copyFileSync(this.filePath, backupPath);
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
    this.audit("backup", null, "created", { file: path.basename(backupPath), checksum });
    this.persist();
    return { file: path.basename(backupPath), path: backupPath, checksum, createdAt: nowIso() };
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
      bookingPolicy: bookingLimits(null, this.todayProvider()),
      language: this.getLanguage(),
    };
  }

  getLanguage() {
    const language = this.scalar(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'interface_language'",
    );
    return ALLOWED_INTERFACE_LANGUAGES.has(language) ? language : "ru";
  }

  setLanguage(language) {
    const normalized = String(language ?? "").trim().toLowerCase();
    if (!ALLOWED_INTERFACE_LANGUAGES.has(normalized)) {
      throw new Error("Доступные языки интерфейса: ru, az, en");
    }
    this.run(
      `INSERT INTO app_settings(setting_key, setting_value, updated_at)
       VALUES ('interface_language', ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_at = excluded.updated_at`,
      [normalized, nowIso()],
    );
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
  DomBookDatabase,
  eachNight,
};

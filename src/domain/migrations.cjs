/**
 * The schema the desktop database migrates itself to, and the migrations that get it there.
 *
 * This lived inside `RentKeeperDatabase` and was the largest thing in that file: 353 lines of
 * schema history, including a 170-line rebuild that turns a pre-UUID database into the current
 * one. Reading the domain did not require any of it, and none of it required the domain. It
 * touches only the storage primitives, which is what made it the first group worth moving.
 *
 * `store` is the whole interface, and it is smaller than it looks: `db` for the raw handle, which
 * multi-statement DDL needs because the wrapped `run` prepares one statement at a time, then
 * `query`, `run`, `scalar`, `insertRow`, `insertRowRaw`, `transaction` and `writerId`. No domain
 * operation appears in the list, which is the point. A migration that needed one would mean the
 * split is wrong rather than that the interface should widen.
 *
 * The dependency points one way. The store does not know this module exists until it calls
 * `migrate`.
 */

const crypto = require("node:crypto");

const { nowIso } = require("./clock.cjs");

const SCHEMA_TABLES = {
  places: `
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    address TEXT NOT NULL DEFAULT '',
    has_food_service INTEGER NOT NULL DEFAULT 0 CHECK(has_food_service IN (0, 1)),
    breakfast_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(breakfast_price_minor >= 0),
    lunch_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(lunch_price_minor >= 0),
    dinner_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(dinner_price_minor >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  properties: `
    id TEXT PRIMARY KEY,
    place_id TEXT REFERENCES places(id),
    kind TEXT NOT NULL DEFAULT 'house' CHECK(kind IN ('cottage', 'house')),
    name TEXT NOT NULL COLLATE NOCASE,
    location TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL CHECK(capacity > 0),
    base_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(base_price_minor >= 0),
    monthly_rate_minor INTEGER NOT NULL DEFAULT 0 CHECK(monthly_rate_minor >= 0),
    -- Seasons and length discounts. TEXT rather than columns because the seasons are a list an
    -- owner edits per unit: a schema with season1_from / season2_rate would cap it and need a
    -- migration for every extra one. The shape is owned by src/domain/booking/pricing.cjs,
    -- which also tolerates a value it cannot read.
    rate_rules TEXT NOT NULL DEFAULT '{}',
    deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK(deposit_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'AZN',
    check_in_time TEXT NOT NULL DEFAULT '15:00',
    check_out_time TEXT NOT NULL DEFAULT '11:00',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  reservations: `
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id),
    guest_name TEXT NOT NULL,
    guest_phone TEXT NOT NULL DEFAULT '',
    guest_email TEXT NOT NULL DEFAULT '',
    check_in_date TEXT NOT NULL,
    check_out_date TEXT NOT NULL,
    adults INTEGER NOT NULL DEFAULT 1 CHECK(adults > 0),
    children INTEGER NOT NULL DEFAULT 0 CHECK(children >= 0),
    -- 'conflict' is set by the SERVER when an offline push collided with another device's
    -- booking. The client cannot choose it (the server refuses to let a client mark its own
    -- row conflicted) but it MUST be able to store it: the value arrives on every pull, and a
    -- local CHECK that rejects it fails the whole sync, permanently, for every user.
    status TEXT NOT NULL CHECK(status IN ('hold','confirmed','checked_in','checked_out','cancelled','no_show','conflict')),
    -- Assigned by the sync engine, shown in the operator's conflict queue. Stored locally so
    -- the queue can describe what actually happened.
    conflict_code TEXT,
    conflict_details TEXT,
    resolved_at TEXT,
    booking_kind TEXT NOT NULL DEFAULT 'stay' CHECK(booking_kind IN ('stay','rental')),
    monthly_rate_minor INTEGER NOT NULL DEFAULT 0 CHECK(monthly_rate_minor >= 0),
    meter_readings TEXT NOT NULL DEFAULT '{}',
    -- How the accommodation amount was arrived at: the nights, the season rates that applied,
    -- and the discount. Stored rather than recomputed because the unit's rules can change after
    -- the booking, and an invoice or a tax receipt that re-derives a different breakdown from
    -- the amount actually charged is worse than no breakdown at all.
    rate_breakdown TEXT NOT NULL DEFAULT '{}',
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
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  reservation_nights: `
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    property_id TEXT NOT NULL REFERENCES properties(id),
    night_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  reservation_services: `
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    service_type TEXT NOT NULL CHECK(service_type IN ('breakfast','lunch','dinner')),
    service_name TEXT NOT NULL,
    unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  reservation_meals: `
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    meal_date TEXT NOT NULL,
    meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast','lunch','dinner')),
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  app_settings: `
    id TEXT PRIMARY KEY,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_writer TEXT NOT NULL DEFAULT ''
  `,
  audit_log: `
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1
  `,
};

const SCHEMA_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS places_name_active_idx ON places(name) WHERE deleted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS places_version_idx ON places(version)",
  "CREATE UNIQUE INDEX IF NOT EXISTS properties_name_active_idx ON properties(name) WHERE deleted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS properties_place_idx ON properties(place_id, status)",
  "CREATE INDEX IF NOT EXISTS properties_version_idx ON properties(version)",
  "CREATE INDEX IF NOT EXISTS reservations_dates_idx ON reservations(check_in_date, check_out_date)",
  "CREATE INDEX IF NOT EXISTS reservations_property_idx ON reservations(property_id, status)",
  "CREATE INDEX IF NOT EXISTS reservations_version_idx ON reservations(version)",
  "CREATE UNIQUE INDEX IF NOT EXISTS reservation_nights_active_idx ON reservation_nights(property_id, night_date) WHERE deleted_at IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS reservation_services_active_idx ON reservation_services(reservation_id, service_type) WHERE deleted_at IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS reservation_meals_active_idx ON reservation_meals(reservation_id, meal_date, meal_type) WHERE deleted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS reservation_meals_reservation_date_idx ON reservation_meals(reservation_id, meal_date)",
  "CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS app_settings_key_idx ON app_settings(setting_key)",
];


function migrate(store) {
    store.db.run("PRAGMA foreign_keys = OFF");
    try {
      for (const [name, sql] of Object.entries(SCHEMA_TABLES)) {
        store.db.run(`CREATE TABLE IF NOT EXISTS ${name} (${sql})`);
      }
      store.db.run(`
        CREATE TABLE IF NOT EXISTS sync_outbox (
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          operation TEXT NOT NULL DEFAULT 'upsert' CHECK(operation IN ('upsert', 'delete')),
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (table_name, row_id)
        );
        CREATE INDEX IF NOT EXISTS sync_outbox_updated_idx ON sync_outbox(updated_at);
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);

      ensureColumn(store, "places", "has_food_service", "INTEGER NOT NULL DEFAULT 0 CHECK(has_food_service IN (0, 1))");
      ensureColumn(store, "places", "breakfast_price_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(breakfast_price_minor >= 0)");
      ensureColumn(store, "places", "lunch_price_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(lunch_price_minor >= 0)");
      ensureColumn(store, "places", "dinner_price_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(dinner_price_minor >= 0)");
      ensureColumn(store, "reservations", "nightly_rate_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(nightly_rate_minor >= 0)");
      ensureColumn(store, "reservations", "accommodation_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(accommodation_minor >= 0)");
      ensureColumn(store, "reservations", "services_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(services_minor >= 0)");
      ensureColumn(store, "reservations", "actual_check_out_date", "TEXT");
      // Long-term rentals. Added to existing databases in place, like the columns above:
      // an installed app must gain the rental fields without a rebuild that would lose
      // local data.
      ensureColumn(store, "properties", "monthly_rate_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(monthly_rate_minor >= 0)");
      // Seasons and length discounts. An installed app must gain them in place: a booking made
      // after the upgrade is priced by the rule set, and a missing column would refuse the save.
      ensureColumn(store, "properties", "rate_rules", "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn(store, "reservations", "booking_kind", "TEXT NOT NULL DEFAULT 'stay'");
      ensureColumn(store, "reservations", "monthly_rate_minor", "INTEGER NOT NULL DEFAULT 0 CHECK(monthly_rate_minor >= 0)");
      ensureColumn(store, "reservations", "meter_readings", "TEXT NOT NULL DEFAULT '{}'");
      ensureColumn(store, "reservations", "rate_breakdown", "TEXT NOT NULL DEFAULT '{}'");
      // SQLite cannot alter a CHECK constraint, so a database created before the conflict
      // status existed rejects the value with "CHECK constraint failed" — and every pull
      // carries conflict rows, so its sync fails forever. The table has to be rebuilt.
      // The conflict columns arrive on every pull, so a database without them fails its
      // FIRST sync and every one after it.
      ensureColumn(store, "reservations", "conflict_code", "TEXT");
      ensureColumn(store, "reservations", "conflict_details", "TEXT");
      ensureColumn(store, "reservations", "resolved_at", "TEXT");
      store.db.run(`
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

      migrateLegacyIntegerIds(store);
      // After every other migration, never before: a legacy database still holds rows keyed by
      // integer that migrateLegacyIntegerIds() rewrites, and rebuilding first copies rows whose
      // timestamps have not been filled in yet — "NOT NULL constraint failed: created_at".
      rebuildReservationsForConflictStatus(store);
      store.db.run(SCHEMA_INDEXES.join(";\n"));

      if (!store.scalar("SELECT 1 FROM schema_migrations WHERE name = 'daily_meals_v1'")) {
        const timestamp = nowIso();
        const serviceMeals = store.query(`
          SELECT rs.reservation_id, r.check_in_date AS meal_date, rs.service_type AS meal_type,
            SUM(rs.unit_price_minor * rs.quantity) AS amount_minor
          FROM reservation_services rs
          JOIN reservations r ON r.id = rs.reservation_id
          GROUP BY rs.reservation_id, r.check_in_date, rs.service_type
          HAVING SUM(rs.unit_price_minor * rs.quantity) > 0
        `);
        serviceMeals.forEach((row) => {
          store.run(
            `INSERT OR IGNORE INTO reservation_meals(
              id, reservation_id, meal_date, meal_type, amount_minor, created_at, updated_at, version, last_writer
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [crypto.randomUUID(), row.reservation_id, row.meal_date, row.meal_type, row.amount_minor, timestamp, timestamp, store.writerId],
          );
        });
        const lunchFallback = store.query(`
          SELECT r.id AS reservation_id, r.check_in_date AS meal_date, r.services_minor AS amount_minor
          FROM reservations r
          WHERE r.services_minor > 0
            AND NOT EXISTS (
              SELECT 1 FROM reservation_meals rm WHERE rm.reservation_id = r.id
            )
        `);
        lunchFallback.forEach((row) => {
          store.run(
            `INSERT OR IGNORE INTO reservation_meals(
              id, reservation_id, meal_date, meal_type, amount_minor, created_at, updated_at, version, last_writer
            ) VALUES (?, ?, ?, 'lunch', ?, ?, ?, 1, ?)`,
            [crypto.randomUUID(), row.reservation_id, row.meal_date, row.amount_minor, timestamp, timestamp, store.writerId],
          );
        });
        store.run(
          "INSERT INTO schema_migrations(name, applied_at) VALUES ('daily_meals_v1', ?)",
          [timestamp],
        );
      }
    } finally {
      ensureOutboxColumns(store);
      store.db.run("PRAGMA foreign_keys = ON");
    }
  }

  // Legacy databases (before UUID ids) have INTEGER PRIMARY KEY AUTOINCREMENT
  // and no sync columns. Rebuild every table into the new schema, generating a
  // UUID per row and re-pointing foreign keys to the new UUIDs. No data is lost.

function migrateLegacyIntegerIds(store) {
    const placesId = store.query("PRAGMA table_info(places)").find((column) => column.name === "id");
    if (!placesId || placesId.type.toUpperCase() === "TEXT") return false;

    const timestamp = nowIso();
    const uuid = () => crypto.randomUUID();

    const placeMap = new Map();
    const propertyMap = new Map();
    const reservationMap = new Map();

    const remap = (value, map) =>
      value === null || value === undefined ? null : (map.get(String(value)) ?? String(value));

    const newPlaces = store.query("SELECT * FROM places").map((row) => {
      const id = uuid();
      placeMap.set(String(row.id), id);
      return {
        id,
        name: row.name,
        address: row.address,
        has_food_service: row.has_food_service,
        breakfast_price_minor: row.breakfast_price_minor,
        lunch_price_minor: row.lunch_price_minor,
        dinner_price_minor: row.dinner_price_minor,
        status: row.status,
        notes: row.notes,
        created_at: row.created_at || timestamp,
        updated_at: row.updated_at || timestamp,
      };
    });
    const newProperties = store.query("SELECT * FROM properties").map((row) => {
      const id = uuid();
      propertyMap.set(String(row.id), id);
      return {
        id,
        place_id: remap(row.place_id, placeMap),
        kind: row.kind,
        name: row.name,
        location: row.location,
        capacity: row.capacity,
        base_price_minor: row.base_price_minor,
        deposit_minor: row.deposit_minor,
        currency: row.currency,
        check_in_time: row.check_in_time,
        check_out_time: row.check_out_time,
        status: row.status,
        notes: row.notes,
        created_at: row.created_at || timestamp,
        updated_at: row.updated_at || timestamp,
      };
    });
    const newReservations = store.query("SELECT * FROM reservations").map((row) => {
      const id = uuid();
      reservationMap.set(String(row.id), id);
      return {
        id,
        property_id: remap(row.property_id, propertyMap) ?? "",
        guest_name: row.guest_name,
        guest_phone: row.guest_phone,
        guest_email: row.guest_email,
        check_in_date: row.check_in_date,
        check_out_date: row.check_out_date,
        adults: row.adults,
        children: row.children,
        status: row.status,
        nightly_rate_minor: row.nightly_rate_minor,
        accommodation_minor: row.accommodation_minor,
        services_minor: row.services_minor,
        total_minor: row.total_minor,
        prepaid_minor: row.prepaid_minor,
        deposit_minor: row.deposit_minor,
        deposit_status: row.deposit_status,
        actual_check_out_date: row.actual_check_out_date,
        notes: row.notes,
        created_at: row.created_at || timestamp,
        updated_at: row.updated_at || timestamp,
      };
    });
    const newNights = store.query("SELECT * FROM reservation_nights").map((row) => ({
      id: uuid(),
      reservation_id: remap(row.reservation_id, reservationMap) ?? "",
      property_id: remap(row.property_id, propertyMap) ?? "",
      night_date: row.night_date,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const newServices = store.query("SELECT * FROM reservation_services").map((row) => ({
      id: uuid(),
      reservation_id: remap(row.reservation_id, reservationMap) ?? "",
      service_type: row.service_type,
      service_name: row.service_name,
      unit_price_minor: row.unit_price_minor,
      quantity: row.quantity,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const newMeals = store.query("SELECT * FROM reservation_meals").map((row) => ({
      id: uuid(),
      reservation_id: remap(row.reservation_id, reservationMap) ?? "",
      meal_date: row.meal_date,
      meal_type: row.meal_type,
      amount_minor: row.amount_minor,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const newSettings = store.query("SELECT * FROM app_settings").map((row) => ({
      id: uuid(),
      setting_key: row.setting_key,
      setting_value: row.setting_value,
      created_at: row.updated_at || timestamp,
      updated_at: row.updated_at || timestamp,
    }));
    const entityMaps = { place: placeMap, property: propertyMap, reservation: reservationMap };
    const newAudit = store.query("SELECT * FROM audit_log").map((row) => ({
      id: uuid(),
      entity_type: row.entity_type,
      entity_id: row.entity_id === null || row.entity_id === undefined
        ? null
        : (entityMaps[row.entity_type]?.get(String(row.entity_id)) ?? String(row.entity_id)),
      action: row.action,
      payload_json: row.payload_json,
      created_at: row.created_at || timestamp,
      updated_at: row.updated_at || timestamp,
    }));

    const rowsByTable = {
      places: newPlaces,
      properties: newProperties,
      reservations: newReservations,
      reservation_nights: newNights,
      reservation_services: newServices,
      reservation_meals: newMeals,
      app_settings: newSettings,
      audit_log: newAudit,
    };

    store.transaction(() => {
      for (const name of Object.keys(SCHEMA_TABLES)) {
        store.db.run(`DROP TABLE IF EXISTS ${name}_new`);
        store.db.run(`CREATE TABLE ${name}_new (${SCHEMA_TABLES[name]})`);
      }
      for (const [name, rows] of Object.entries(rowsByTable)) {
        rows.forEach((row) => store.insertRow(`${name}_new`, row));
      }
      const dropOrder = [
        "reservation_nights",
        "reservation_services",
        "reservation_meals",
        "reservations",
        "properties",
        "places",
        "app_settings",
        "audit_log",
      ];
      for (const name of dropOrder) store.db.run(`DROP TABLE ${name}`);
      for (const name of Object.keys(SCHEMA_TABLES)) {
        store.db.run(`ALTER TABLE ${name}_new RENAME TO ${name}`);
      }
      store.run(
        "INSERT INTO schema_migrations(name, applied_at) VALUES ('sync_schema_v1', ?)",
        [timestamp],
      );
    });
    return true;
  }

  /**
   * Rebuild `reservations` so its status CHECK accepts 'conflict'.
   *
   * A rebuild rather than an ALTER because SQLite has no way to change a CHECK. Rows are
   * copied verbatim, so no data is transformed; the ONLY change is the constraint. Runs once,
   * gated by schema_migrations, and is a no-op on a database that already allows the value.
   */

function rebuildReservationsForConflictStatus(store) {
    if (store.scalar("SELECT 1 FROM schema_migrations WHERE name = 'reservation_conflict_status_v1'")) return false;

    const ddl = store.scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reservations'");
    if (ddl && ddl.includes("'conflict'")) {
      // Already correct (a fresh database). Record it so this is not re-checked every start.
      store.run("INSERT INTO schema_migrations(name, applied_at) VALUES ('reservation_conflict_status_v1', ?)", [nowIso()]);
      return false;
    }

    const timestamp = nowIso();
    const rows = store.query("SELECT * FROM reservations");
    const nightRows = store.query("SELECT * FROM reservation_nights");
    const serviceRows = store.query("SELECT * FROM reservation_services");
    const mealRows = store.query("SELECT * FROM reservation_meals");

    store.transaction(() => {
      store.db.run("DROP TABLE IF EXISTS reservations_new");
      store.db.run(`CREATE TABLE reservations_new (${SCHEMA_TABLES.reservations})`);
      rows.forEach((row) => store.insertRowRaw("reservations_new", row));
      // Children reference reservations(id); they are moved across too, or the nights of every
      // booking would be orphaned by the rebuild.
      store.db.run("DROP TABLE IF EXISTS reservation_nights_new");
      store.db.run(`CREATE TABLE reservation_nights_new (${SCHEMA_TABLES.reservation_nights})`);
      nightRows.forEach((row) => store.insertRowRaw("reservation_nights_new", row));
      store.db.run("DROP TABLE IF EXISTS reservation_services_new");
      store.db.run(`CREATE TABLE reservation_services_new (${SCHEMA_TABLES.reservation_services})`);
      serviceRows.forEach((row) => store.insertRowRaw("reservation_services_new", row));
      store.db.run("DROP TABLE IF EXISTS reservation_meals_new");
      store.db.run(`CREATE TABLE reservation_meals_new (${SCHEMA_TABLES.reservation_meals})`);
      mealRows.forEach((row) => store.insertRowRaw("reservation_meals_new", row));

      store.db.run("DROP TABLE reservation_nights");
      store.db.run("DROP TABLE reservation_services");
      store.db.run("DROP TABLE reservation_meals");
      store.db.run("DROP TABLE reservations");
      store.db.run("ALTER TABLE reservations_new RENAME TO reservations");
      store.db.run("ALTER TABLE reservation_nights_new RENAME TO reservation_nights");
      store.db.run("ALTER TABLE reservation_services_new RENAME TO reservation_services");
      store.db.run("ALTER TABLE reservation_meals_new RENAME TO reservation_meals");
      store.run("INSERT INTO schema_migrations(name, applied_at) VALUES ('reservation_conflict_status_v1', ?)", [timestamp]);
    });
    return true;
  }

  /** Insert a row without queueing it for sync. Used only by schema rebuilds. */


  // Bring an existing outbox up to date. A database created before the revision column
  // existed would otherwise fail every enqueue with "no such column".
function ensureOutboxColumns(store) {
    for (const [column, definition] of [["revision", "INTEGER NOT NULL DEFAULT 1"]]) {
      const exists = store.query("PRAGMA table_info(sync_outbox)").some((item) => item.name === column);
      if (!exists) store.db.run(`ALTER TABLE sync_outbox ADD COLUMN ${column} ${definition}`);
    }
  }


function ensureColumn(store, table, column, definition) {
    const exists = store.query(`PRAGMA table_info(${table})`).some((item) => item.name === column);
    if (!exists) store.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }


module.exports = {
  migrate,
  migrateLegacyIntegerIds,
  rebuildReservationsForConflictStatus,
  SCHEMA_TABLES,
  SCHEMA_INDEXES,
};

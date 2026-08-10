-- 0001_baseline.sql — DomBook SaaS baseline schema.
-- Multi-tenant model on top of the desktop schema (src/database.cjs):
--   * accounts = one row per "дом отдыха" business (tenant).
--   * users    = authenticated identities (owner / admin / staff).
--   * invites  = email invitations to join an account.
--   * Every domain table gains tenant_id, UUID id, soft-delete deleted_at
--     and sync columns (updated_at + version). tenant_state holds the
--     server-monotonic sync watermark per tenant.
-- SQLite-compatible so it can be re-hosted on a VPS (plain SQLite) later.

-- ---------------------------------------------------------------------------
-- Auth / tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Mirrors the table layout the Workers Auth provider uses, so the in-repo
-- provider can later be swapped for `@cloudflare/workers-auth-provider`
-- without a schema migration.
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'admin', 'staff')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE verification_codes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX verification_codes_email_idx ON verification_codes(email, used_at);

-- jti of the issued JWT session token; supports logout/revocation.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email      TEXT NOT NULL COLLATE NOCASE,
  role       TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX invites_account_email_idx ON invites(account_id, email);

-- Server-monotonic sync watermark per tenant (robust against clock skew).
CREATE TABLE tenant_state (
  tenant_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Domain tables (desktop schema + tenant_id, UUID id, soft delete, sync)
-- ---------------------------------------------------------------------------

CREATE TABLE places (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES accounts(id),
  name                  TEXT NOT NULL COLLATE NOCASE,
  address               TEXT NOT NULL DEFAULT '',
  has_food_service      INTEGER NOT NULL DEFAULT 0 CHECK (has_food_service IN (0, 1)),
  breakfast_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (breakfast_price_minor >= 0),
  lunch_price_minor     INTEGER NOT NULL DEFAULT 0 CHECK (lunch_price_minor >= 0),
  dinner_price_minor    INTEGER NOT NULL DEFAULT 0 CHECK (dinner_price_minor >= 0),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  version               INTEGER NOT NULL DEFAULT 1,
  last_writer           TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX places_tenant_name_active_idx
  ON places(tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX places_tenant_version_idx ON places(tenant_id, version);

CREATE TABLE properties (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES accounts(id),
  place_id        TEXT REFERENCES places(id),
  kind            TEXT NOT NULL DEFAULT 'house' CHECK (kind IN ('cottage', 'house')),
  name            TEXT NOT NULL COLLATE NOCASE,
  location        TEXT NOT NULL DEFAULT '',
  capacity        INTEGER NOT NULL CHECK (capacity > 0),
  base_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (base_price_minor >= 0),
  deposit_minor   INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  currency        TEXT NOT NULL DEFAULT 'AZN',
  check_in_time   TEXT NOT NULL DEFAULT '15:00',
  check_out_time  TEXT NOT NULL DEFAULT '11:00',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  last_writer     TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX properties_tenant_name_active_idx
  ON properties(tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX properties_tenant_place_idx ON properties(tenant_id, place_id, status);
CREATE INDEX properties_tenant_version_idx ON properties(tenant_id, version);

CREATE TABLE reservations (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES accounts(id),
  property_id          TEXT NOT NULL REFERENCES properties(id),
  guest_name           TEXT NOT NULL,
  guest_phone          TEXT NOT NULL DEFAULT '',
  guest_email          TEXT NOT NULL DEFAULT '',
  check_in_date        TEXT NOT NULL,
  check_out_date       TEXT NOT NULL,
  adults               INTEGER NOT NULL DEFAULT 1 CHECK (adults > 0),
  children             INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  status               TEXT NOT NULL CHECK (status IN ('hold', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  nightly_rate_minor   INTEGER NOT NULL DEFAULT 0 CHECK (nightly_rate_minor >= 0),
  accommodation_minor  INTEGER NOT NULL DEFAULT 0 CHECK (accommodation_minor >= 0),
  services_minor       INTEGER NOT NULL DEFAULT 0 CHECK (services_minor >= 0),
  total_minor          INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  prepaid_minor        INTEGER NOT NULL DEFAULT 0 CHECK (prepaid_minor >= 0),
  deposit_minor        INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  deposit_status       TEXT NOT NULL DEFAULT 'none' CHECK (deposit_status IN ('none', 'due', 'received', 'returned', 'partially_withheld', 'withheld')),
  actual_check_out_date TEXT,
  notes                TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  last_writer          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX reservations_tenant_dates_idx
  ON reservations(tenant_id, check_in_date, check_out_date);
CREATE INDEX reservations_tenant_property_idx
  ON reservations(tenant_id, property_id, status);
CREATE INDEX reservations_tenant_version_idx ON reservations(tenant_id, version);

CREATE TABLE reservation_nights (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  property_id    TEXT NOT NULL REFERENCES properties(id),
  night_date     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  last_writer    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reservation_nights_active_idx
  ON reservation_nights(property_id, night_date) WHERE deleted_at IS NULL;
CREATE INDEX reservation_nights_tenant_property_idx
  ON reservation_nights(tenant_id, property_id, night_date);
CREATE INDEX reservation_nights_tenant_version_idx ON reservation_nights(tenant_id, version);

CREATE TABLE reservation_services (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES accounts(id),
  reservation_id   TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  service_type     TEXT NOT NULL CHECK (service_type IN ('breakfast', 'lunch', 'dinner')),
  service_name     TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  last_writer      TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reservation_services_active_idx
  ON reservation_services(reservation_id, service_type) WHERE deleted_at IS NULL;
CREATE INDEX reservation_services_tenant_version_idx ON reservation_services(tenant_id, version);

CREATE TABLE reservation_meals (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES accounts(id),
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  meal_date      TEXT NOT NULL,
  meal_type      TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner')),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  last_writer    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reservation_meals_active_idx
  ON reservation_meals(reservation_id, meal_date, meal_type) WHERE deleted_at IS NULL;
CREATE INDEX reservation_meals_tenant_reservation_date_idx
  ON reservation_meals(tenant_id, reservation_id, meal_date);
CREATE INDEX reservation_meals_tenant_version_idx ON reservation_meals(tenant_id, version);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES accounts(id),
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  action       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX audit_log_tenant_created_idx ON audit_log(tenant_id, created_at DESC);

CREATE TABLE app_settings (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES accounts(id),
  setting_key   TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  last_writer   TEXT NOT NULL DEFAULT '',
  UNIQUE (tenant_id, setting_key)
);
CREATE INDEX app_settings_tenant_version_idx ON app_settings(tenant_id, version);

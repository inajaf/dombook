-- +goose Up
-- 0001_baseline.sql — DomBook SaaS schema for PostgreSQL.
--
-- Ported from the SQLite/D1 baseline (git history: backend/migrations/0001_baseline.sql).
-- The table and column names are preserved deliberately: the sync protocol keys on
-- them, so keeping them means existing `fixtures` and client payloads stay valid.
-- What changes is the typing:
--
--   * ids            TEXT -> uuid          (validated, 16 bytes, not a free string)
--   * timestamps     TEXT -> timestamptz   (real comparison, not lexicographic luck)
--   * names/emails   COLLATE NOCASE -> citext
--
-- Security posture: every tenant-scoped table gets a tenant_id and has RLS
-- enabled in 0002. Application-level checks are the UX layer (good error
-- messages); RLS is the enforcement layer. Do not add a tenant table without
-- enabling RLS on it — 0002 ends with a check that fails the migration if one
-- is missing.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email/name uniqueness
-- btree_gist supplies the equality operator classes that let a GiST exclusion
-- constraint mix a uuid column with a range column. Without it the
-- double-booking constraint in 0002 cannot be created.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Auth / tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  plan            text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
  -- Per-account booking window. jsonb so the rule set can grow without a
  -- migration; the shape is validated in Go (domain.Policy) before it is stored.
  booking_policy  jsonb NOT NULL DEFAULT '{"maximumAdvanceDays": 21, "maximumStayMonths": 3, "timeZone": "Asia/Baku"}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email      citext NOT NULL UNIQUE,
  name       text NOT NULL DEFAULT '',
  role       text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'admin', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_account_idx ON users(account_id);

-- One-time login codes. The code is stored hashed; the plaintext only exists in
-- the email or in the dev-mode API response.
CREATE TABLE verification_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      citext NOT NULL,
  code_hash  text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_codes_email_idx ON verification_codes(email, used_at);

-- Access-token sessions. `id` is the JWT jti; revoking the row kills the token
-- before its expiry, which is what makes logout immediate rather than advisory.
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id  uuid,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Registered client installs. A device can be revoked independently of a user,
-- which matters for a stolen laptop: revoke the device, keep the account.
CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL DEFAULT '',
  platform     text NOT NULL DEFAULT '',
  last_sync_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_account_idx ON devices(account_id);

-- Rotating refresh tokens. Only the hash is stored. `replaced_by` records the
-- rotation chain so replaying a consumed token can be detected and the whole
-- family revoked (see the refresh handler).
--
-- account_id is denormalized from user_id on purpose: it makes the RLS policy a
-- direct comparison instead of a join to users, and it lets an account-wide
-- revoke ("sign out everywhere") be a single indexed update.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Groups every token descended from one login, so detecting reuse anywhere in
  -- the rotation chain revokes the whole family in a single indexed update rather
  -- than walking links one at a time.
  family_id   uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_account_idx ON refresh_tokens(account_id);
-- Reuse detection and family revocation both look up by family.
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  role       text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  token_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX invites_account_email_idx ON invites(account_id, email);

-- Server-monotonic sync watermark per tenant. Deliberately NOT a client-supplied
-- value and NOT wall-clock based: it is the total order the sync protocol relies
-- on, and clock skew must not be able to influence it.
CREATE TABLE tenant_state (
  tenant_id  uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Domain tables
-- ---------------------------------------------------------------------------

-- A "дом отдыха": a group of bookable units sharing a location.
CREATE TABLE places (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                  citext NOT NULL,
  address               text NOT NULL DEFAULT '',
  has_food_service      boolean NOT NULL DEFAULT false,
  breakfast_price_minor bigint NOT NULL DEFAULT 0 CHECK (breakfast_price_minor >= 0),
  lunch_price_minor     bigint NOT NULL DEFAULT 0 CHECK (lunch_price_minor >= 0),
  dinner_price_minor    bigint NOT NULL DEFAULT 0 CHECK (dinner_price_minor >= 0),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes                 text NOT NULL DEFAULT '',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  version               bigint NOT NULL DEFAULT 1,
  last_writer           text NOT NULL DEFAULT ''
);
-- Uniqueness applies to live rows only: an archived or deleted place must not
-- block reusing its name.
CREATE UNIQUE INDEX places_tenant_name_active_idx
  ON places(tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX places_tenant_version_idx ON places(tenant_id, version);

-- A bookable unit: a cottage inside a place, or a standalone house (place_id null).
-- `unit` is the licensing unit — see the free-plan limits.
CREATE TABLE units (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  place_id       uuid REFERENCES places(id) ON DELETE SET NULL,
  kind           text NOT NULL DEFAULT 'cottage' CHECK (kind IN ('cottage', 'house')),
  name           citext NOT NULL,
  location       text NOT NULL DEFAULT '',
  capacity       integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  base_price_minor bigint NOT NULL DEFAULT 0 CHECK (base_price_minor >= 0),
  deposit_minor  bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  currency       text NOT NULL DEFAULT 'AZN',
  check_in_time  text NOT NULL DEFAULT '15:00',
  check_out_time text NOT NULL DEFAULT '11:00',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        bigint NOT NULL DEFAULT 1,
  last_writer    text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX units_tenant_name_active_idx
  ON units(tenant_id, name) WHERE deleted_at IS NULL;
CREATE INDEX units_tenant_version_idx ON units(tenant_id, version);
CREATE INDEX units_tenant_place_idx ON units(tenant_id, place_id);

CREATE TABLE reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  unit_id            uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  guest_name         text NOT NULL DEFAULT '',
  guest_phone        text NOT NULL DEFAULT '',
  guest_email        text NOT NULL DEFAULT '',
  check_in_date      date NOT NULL,
  check_out_date     date NOT NULL,
  adults             integer NOT NULL DEFAULT 1 CHECK (adults >= 0),
  children           integer NOT NULL DEFAULT 0 CHECK (children >= 0),
  status             text NOT NULL DEFAULT 'confirmed'
                       CHECK (status IN ('hold','confirmed','checked_in','checked_out','cancelled','no_show','conflict')),
  -- Rate captured at booking time, so a later price change does not silently reprice
  -- an existing stay. Stored rather than derived from accommodation_minor because a
  -- stay edited after an early check-out keeps its original rate while its
  -- accommodation total stays frozen.
  nightly_rate_minor bigint NOT NULL DEFAULT 0 CHECK (nightly_rate_minor >= 0),
  accommodation_minor bigint NOT NULL DEFAULT 0 CHECK (accommodation_minor >= 0),
  services_minor     bigint NOT NULL DEFAULT 0 CHECK (services_minor >= 0),
  total_minor        bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  prepaid_minor      bigint NOT NULL DEFAULT 0 CHECK (prepaid_minor >= 0),
  deposit_minor      bigint NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  deposit_status     text NOT NULL DEFAULT 'none'
                       CHECK (deposit_status IN ('none','due','received','returned','partially_withheld','withheld')),
  notes              text NOT NULL DEFAULT '',
  -- Set when a guest leaves before the booked check-out. Meal totals are truncated
  -- at this date while the accommodation total stays as charged, which is why the
  -- value is stored rather than recomputed from the dates.
  actual_check_out_date date,
  -- Set when an offline push could not be applied. The booking is preserved
  -- rather than dropped, and an admin resolves it. See 0002 for the exclusion
  -- constraint that detects the collision.
  conflict_code      text,
  conflict_details   jsonb,
  -- Set once an operator has reviewed a conflict. A conflict row is never deleted: the
  -- guest's booking stays visible, and the audit trail of what happened to it matters
  -- more than the tidiness of the queue.
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            bigint NOT NULL DEFAULT 1,
  last_writer        text NOT NULL DEFAULT '',
  CONSTRAINT reservations_dates_ordered CHECK (check_out_date > check_in_date),
  -- An early check-out outside the booked stay is meaningless and would silently
  -- distort meal totals, so it is refused at the storage layer too.
  CONSTRAINT reservations_actual_checkout_within_stay
    CHECK (actual_check_out_date IS NULL
           OR (actual_check_out_date >= check_in_date AND actual_check_out_date < check_out_date)),
  CONSTRAINT reservations_prepaid_within_total CHECK (prepaid_minor <= total_minor),
  -- A conflicted booking is a real conflict, so the two fields must agree.
  CONSTRAINT reservations_conflict_code_present
    CHECK ((conflict_code IS NULL) = (conflict_details IS NULL))
);
CREATE INDEX reservations_tenant_dates_idx ON reservations(tenant_id, check_in_date, check_out_date);
CREATE INDEX reservations_tenant_unit_idx ON reservations(tenant_id, unit_id, status);
CREATE INDEX reservations_tenant_version_idx ON reservations(tenant_id, version);
-- Conflict resolution is an admin queue: find unresolved conflicts fast.
CREATE INDEX reservations_conflicts_idx
  ON reservations(tenant_id, created_at) WHERE conflict_code IS NOT NULL;

-- One row per occupied night. This is the authoritative double-booking guard at
-- the row level; the daterange exclusion constraint in 0002 is the second guard
-- that also covers edited date ranges.
CREATE TABLE reservation_nights (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  unit_id        uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  night_date     date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        bigint NOT NULL DEFAULT 1,
  last_writer    text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reservation_nights_active_idx
  ON reservation_nights(unit_id, night_date) WHERE deleted_at IS NULL;
CREATE INDEX reservation_nights_tenant_unit_idx ON reservation_nights(tenant_id, unit_id, night_date);
CREATE INDEX reservation_nights_tenant_version_idx ON reservation_nights(tenant_id, version);

-- Meals and extra services attached to a reservation.
CREATE TABLE reservation_services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reservation_id   uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  service_type     text NOT NULL CHECK (service_type IN ('breakfast','lunch','dinner')),
  unit_price_minor bigint NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  quantity         integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  version          bigint NOT NULL DEFAULT 1,
  last_writer      text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reservation_services_active_idx
  ON reservation_services(reservation_id, service_type) WHERE deleted_at IS NULL;
CREATE INDEX reservation_services_tenant_version_idx ON reservation_services(tenant_id, version);

-- Per-date meal breakdown, used for the daily meal totals on the calendar.
CREATE TABLE reservation_meals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  meal_date      date NOT NULL,
  meal_type      text NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner')),
  amount_minor   bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  version        bigint NOT NULL DEFAULT 1,
  last_writer    text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reservation_meals_active_idx
  ON reservation_meals(reservation_id, meal_date, meal_type) WHERE deleted_at IS NULL;
CREATE INDEX reservation_meals_tenant_version_idx ON reservation_meals(tenant_id, version);

-- Generic key/value tenant settings (theme, language, device id, ...).
CREATE TABLE app_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  setting_key text NOT NULL,
  setting_value text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  version     bigint NOT NULL DEFAULT 1,
  last_writer text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX app_settings_tenant_key_idx
  ON app_settings(tenant_id, setting_key) WHERE deleted_at IS NULL;
CREATE INDEX app_settings_tenant_version_idx ON app_settings(tenant_id, version);

-- Append-only audit trail. Deliberately not tenant-syncable: it is a server-side
-- record of what happened, not replicated state.
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id   uuid,
  action      text NOT NULL,
  actor_id    uuid,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_created_idx ON audit_log(tenant_id, created_at DESC);

-- +goose Down
-- Reverse dependency order. Extensions are NOT dropped: they may be shared with
-- other schemas in the same database, and dropping them would be a side effect
-- far outside this migration's remit.
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS app_settings;
DROP TABLE IF EXISTS reservation_meals;
DROP TABLE IF EXISTS reservation_services;
DROP TABLE IF EXISTS reservation_nights;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS units;
DROP TABLE IF EXISTS places;
DROP TABLE IF EXISTS tenant_state;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS verification_codes;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS accounts;

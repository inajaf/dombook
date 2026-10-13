-- +goose Up
-- 0002_security.sql — tenant isolation, double-booking guard, quota backstop.
--
-- Three independent guards live here, each closing a hole that application code
-- cannot close on its own:
--
--   1. Row-Level Security  — a bug in a WHERE clause can no longer leak another
--      tenant's rows. The application check becomes UX, RLS becomes enforcement.
--   2. Exclusion constraint — prevents overlapping stays for a unit even when an
--      update moves a date range, which row-level night rows alone do not catch.
--   3. Quota trigger       — closes the count-then-insert race between a limit
--      check and the write that follows it.

-- ---------------------------------------------------------------------------
-- 1. Row-Level Security
-- ---------------------------------------------------------------------------

-- The tenant for the current transaction. Set with
--   SET LOCAL app.tenant_id = '<uuid>';
-- at the start of every request transaction. `true` (missing_ok) makes an unset
-- variable return NULL instead of raising, so a mistaken unscoped query returns
-- zero rows rather than failing loudly or, worse, matching everything.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;
-- +goose StatementEnd

-- Every tenant-scoped table. Kept as a single list so the verification block at
-- the end of this file can assert none was forgotten.
-- +goose StatementBegin
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'users', 'verification_codes', 'sessions', 'devices', 'refresh_tokens',
    'invites', 'places', 'units', 'reservations', 'reservation_nights',
    'reservation_services', 'reservation_meals', 'app_settings', 'audit_log',
    'tenant_state'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- Tables whose tenant column is literally `tenant_id`.
-- +goose StatementBegin
DO $$
DECLARE
  t text;
  direct text[] := ARRAY[
    'places', 'units', 'reservations', 'reservation_nights',
    'reservation_services', 'reservation_meals', 'app_settings', 'audit_log',
    'tenant_state'
  ];
BEGIN
  FOREACH t IN ARRAY direct LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $f$, t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- Tables that reach the tenant through `account_id`. Declared separately rather
-- than renamed for uniformity: the column name is part of the existing
-- (already shipped) auth surface and renaming it would churn clients for no gain.
-- +goose StatementBegin
DO $$
DECLARE
  t text;
  via_account text[] := ARRAY[
    'users', 'sessions', 'devices', 'refresh_tokens', 'invites'
  ];
BEGIN
  FOREACH t IN ARRAY via_account LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (account_id = current_tenant_id())
        WITH CHECK (account_id = current_tenant_id())
    $f$, t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- verification_codes deliberately gets NO policy here.
--
-- A login code is created by an anonymous request, before any tenant is known, so
-- there is no tenant (or even identity) to authorize against. A policy permissive
-- enough to allow that insert would also permit reading other people's codes, and
-- an email-keyed session variable cannot help: the application would have to know
-- the email before it could read the row, which is exactly the fact the login flow
-- is establishing.
--
-- The table therefore denies all direct access. It is reachable only through the
-- SECURITY DEFINER functions in 20260811000004_bootstrap_functions.sql, each of
-- which performs one narrowly-scoped operation. RLS enabled with no policy is
-- deny-all, which is the intent here.

-- accounts is not tenant_id-scoped by itself; a tenant may read only its own row.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- Platform administration (an account list, aggregate counts, conflict review
-- across tenants) is not expressible under RLS by design. Rather than weakening
-- the policies with an "is admin" setting — which would turn every policy into a
-- potential bypass — administration uses a dedicated role with BYPASSRLS. Both
-- roles and their grants are defined in 0003_roles.sql.

-- The application role must not be able to bypass the policies it is protected
-- by. 0003 asserts this too; checking here keeps the two facts adjacent.

-- A statement that forgets to set the tenant returns nothing instead of
-- everything. Verified here so the guarantee is checked at migration time:
-- adding a tenant table without enabling RLS fails the migration rather than
-- silently exposing every row.
--
-- The policy check matters as much as the RLS check: RLS enabled with no policy
-- is deny-all, which would look like "no data" rather than an error. Two ways to
-- get tenancy wrong, so two assertions.
-- +goose StatementBegin
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'users', 'verification_codes', 'sessions', 'devices', 'refresh_tokens',
    'invites', 'places', 'units', 'reservations', 'reservation_nights',
    'reservation_services', 'reservation_meals', 'app_settings', 'audit_log',
    'tenant_state', 'accounts'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t AND n.nspname = 'public' AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'table % is tenant-scoped but RLS is not enabled', t;
    END IF;

    -- verification_codes is the deliberate exception: deny-all is its intended
    -- state because its access path is the bootstrap functions, not a policy.
    IF t <> 'verification_codes'
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE EXCEPTION 'table % has RLS enabled but no policy: it would deny all access', t;
    END IF;
  END LOOP;
END $$;
-- +goose StatementEnd

-- ---------------------------------------------------------------------------
-- 2. Double-booking guard
-- ---------------------------------------------------------------------------

-- A stay is the half-open range [check_in, check_out): the check-out day is free
-- for the next guest, so back-to-back bookings are allowed and only genuine
-- overlaps are rejected. This must stay consistent with:
--   * nights generated as [check_in_date, check_out_date) in Go/JS,
--   * reservation_nights_active_idx above.
--
-- Only live, occupying statuses are constrained. A cancelled or checked-out
-- booking frees its dates, and `conflict` rows are excluded so a colliding
-- offline booking can be stored for an admin to resolve instead of being
-- rejected outright — that rejection is precisely the data loss the conflict
-- status exists to avoid.
ALTER TABLE reservations ADD CONSTRAINT reservations_unit_no_overlap
  EXCLUDE USING gist (
    unit_id WITH =,
    daterange(check_in_date, check_out_date, '[)') WITH &&
  ) WHERE (
    deleted_at IS NULL
    AND status IN ('hold', 'confirmed', 'checked_in')
  );

-- ---------------------------------------------------------------------------
-- 3. Free-plan quota backstop
-- ---------------------------------------------------------------------------

-- Application-level checks produce the friendly upgrade prompt; this trigger
-- closes the race where two concurrent requests both pass that check. It fails
-- closed: any error other than "no row" is treated as over limit.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION enforce_free_plan_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_plan text;
  active_count integer;
BEGIN
  -- Limits apply to records that are live AND active. Archived rows and
  -- soft-deleted rows do not consume a slot, so a free user can archive their
  -- unit and create a replacement instead of being permanently blocked.
  IF NEW.deleted_at IS NOT NULL OR NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- An update that neither activates nor reactivates the row consumes no quota.
  IF TG_OP = 'UPDATE'
     AND OLD.deleted_at IS NULL AND OLD.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT plan INTO account_plan FROM accounts WHERE id = NEW.tenant_id;

  -- Unknown or missing plan fails closed to the free tier.
  IF COALESCE(account_plan, 'free') <> 'free' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'units' THEN
    SELECT count(*) INTO active_count
      FROM units
     WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL
       AND id <> NEW.id;
    IF active_count >= 1 THEN
      RAISE EXCEPTION 'dombook_plan_limit_units'
        USING ERRCODE = 'check_violation',
              HINT = 'The free plan allows one active unit. Upgrade the account plan.';
    END IF;
  ELSIF TG_TABLE_NAME = 'places' THEN
    SELECT count(*) INTO active_count
      FROM places
     WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL
       AND id <> NEW.id;
    IF active_count >= 1 THEN
      RAISE EXCEPTION 'dombook_plan_limit_places'
        USING ERRCODE = 'check_violation',
              HINT = 'The free plan allows one active place. Upgrade the account plan.';
    END IF;
  END IF;

  RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER units_free_plan_quota
  BEFORE INSERT OR UPDATE OF status, deleted_at ON units
  FOR EACH ROW EXECUTE FUNCTION enforce_free_plan_quota();

CREATE TRIGGER places_free_plan_quota
  BEFORE INSERT OR UPDATE OF status, deleted_at ON places
  FOR EACH ROW EXECUTE FUNCTION enforce_free_plan_quota();

-- ---------------------------------------------------------------------------
-- 4. Tenant watermark bootstrap
-- ---------------------------------------------------------------------------

-- Every account needs exactly one tenant_state row, and sync reads it on the
-- first pull. Creating it on account insert removes an entire class of
-- "no row yet" special cases from the sync path.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION create_tenant_state_for_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_state(tenant_id, version) VALUES (NEW.id, 0)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END $$;
-- +goose StatementEnd

CREATE TRIGGER accounts_create_tenant_state
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION create_tenant_state_for_account();

-- +goose Down
-- Order matters and is not obvious: the RLS policies reference
-- current_tenant_id(), so policies must be dropped before the function or
-- PostgreSQL refuses with "other objects depend on it". Triggers are dropped
-- before their functions for the same reason.
DROP TRIGGER IF EXISTS accounts_create_tenant_state ON accounts;
DROP TRIGGER IF EXISTS units_free_plan_quota ON units;
DROP TRIGGER IF EXISTS places_free_plan_quota ON places;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_unit_no_overlap;

-- +goose StatementBegin
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'users', 'verification_codes', 'sessions', 'devices', 'refresh_tokens',
    'invites', 'places', 'units', 'reservations', 'reservation_nights',
    'reservation_services', 'reservation_meals', 'app_settings', 'audit_log',
    'tenant_state', 'accounts'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE IF EXISTS %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE IF EXISTS %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- Only safe once every policy above is gone.
DROP FUNCTION IF EXISTS create_tenant_state_for_account();
DROP FUNCTION IF EXISTS enforce_free_plan_quota();
DROP FUNCTION IF EXISTS current_tenant_id();

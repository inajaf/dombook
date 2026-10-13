-- +goose Up
-- 0003_roles.sql — database roles and privileges.
--
-- Two roles with different trust levels, both able to connect. Keeping them separate is
-- the point:
-- the customer API connects as dombook_app, which is subject to RLS and can
-- therefore never read across tenants even if its SQL is wrong. Platform
-- administration (account lists, cross-tenant conflict review) is not
-- expressible under RLS, so it uses dombook_admin, which has BYPASSRLS. The two
-- credentials are never interchangeable, so a compromised request path cannot
-- escalate into cross-tenant reads by setting a session variable.

-- +goose StatementBegin
DO $$
BEGIN
  -- NOSUPERUSER + NOBYPASSRLS are stated explicitly rather than left to the
  -- default: these are the properties the whole isolation model rests on, and a
  -- future default change must not be able to weaken them silently.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dombook_app') THEN
    CREATE ROLE dombook_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  -- LOGIN, not NOLOGIN: this role exists to be connected AS by the admin surface, which
  -- uses a separate DSN from the customer path. Creating it NOLOGIN would make every
  -- deployment fail at startup with "role is not permitted to log in", and the mistake
  -- would only surface when someone enabled the operator endpoints.
  --
  -- The password is provisioned by the operator (see server/README.md); this migration
  -- deliberately does not set one, so a default credential cannot ship to production.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dombook_admin') THEN
    CREATE ROLE dombook_admin LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- Corrective, and it must stay outside the IF: a database that ran an earlier revision
  -- of this migration already has the role, created NOLOGIN, and CREATE ROLE would be
  -- skipped. Without this line such a database can never enable the admin surface, and
  -- the failure appears only when an operator tries to connect.
  ALTER ROLE dombook_admin LOGIN;
END $$;
-- +goose StatementEnd

GRANT USAGE ON SCHEMA public TO dombook_app, dombook_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dombook_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dombook_admin;

-- Sequences are only needed if a future table uses a serial-style key; granted
-- now so that adding one does not silently break the app role.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dombook_app, dombook_admin;

-- Objects created by later migrations should be usable without re-granting.
-- IMPORTANT: default privileges bind to the role that RUNS the migrations (the
-- object owner), not to the roles being granted. If migrations are later run by
-- a different role, these lines silently stop applying to its objects. Keep one
-- migration role per database; see server/README.md.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dombook_app, dombook_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dombook_app, dombook_admin;

-- dombook_app must never be able to bypass the tenant policies. If this fails,
-- the isolation guarantee in 0002 is void, so fail loudly at migration time
-- rather than discovering it in production.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'dombook_app' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'dombook_app must not be SUPERUSER or BYPASSRLS: tenant isolation depends on it';
  END IF;

  -- Both roles are meant to be logged into. Checking here turns a deployment-time
  -- surprise into a migration failure with an explanation.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dombook_app' AND NOT rolcanlogin) THEN
    RAISE EXCEPTION 'dombook_app must be able to log in: the API connects as it';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dombook_admin' AND NOT rolcanlogin) THEN
    RAISE EXCEPTION 'dombook_admin must be able to log in: the admin surface connects as it';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- Roles are cluster-level, not database-level: dropping them here would revoke
-- access for every other database that uses them. Grants are dropped instead,
-- and role removal is left as an explicit operator decision.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dombook_app, dombook_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dombook_app, dombook_admin;
REVOKE USAGE ON SCHEMA public FROM dombook_app, dombook_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM dombook_app, dombook_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM dombook_app, dombook_admin;

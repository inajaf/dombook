-- +goose Up
-- 0010_rename_roles.sql — the database roles are named after the product, and the product is
-- RentKeeper.
--
-- This migration ADDS `rentkeeper_app` and `rentkeeper_admin`. It does NOT drop
-- `dombook_app` / `dombook_admin`, and that is deliberate rather than unfinished:
--
--   * Roles are CLUSTER-level, not database-level. Every database on the server shares them,
--     including ones this migration never runs against, so a DROP here can revoke access for
--     an installation this code knows nothing about.
--   * An existing deployment connects with the old names in its DSN and its secret store.
--     Removing the role while a running process still authenticates as it is an outage, and
--     the operator has to change credentials either way — so that decision belongs to them,
--     not to a migration that runs unattended on deploy.
--   * Granting to the new roles is additive and cannot fail where the old ones are still in
--     use, whereas revoking from the old ones can.
--
-- What the operator does after deploying this: point DOMBOOK_DSN / DOMBOOK_ADMIN_DSN at the
-- new roles (the passwords are theirs to provision), then, once nothing authenticates as the
-- old ones, `DROP ROLE dombook_app, dombook_admin`. See server/README.md.
--
-- The attributes are stated explicitly for the same reason as in 0003: these are the
-- properties the isolation model rests on, and a future PostgreSQL default change must not be
-- able to weaken them silently.
-- +goose StatementBegin
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rentkeeper_app') THEN
    CREATE ROLE rentkeeper_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- LOGIN, not NOLOGIN: the admin surface connects AS this role over a separate DSN.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rentkeeper_admin') THEN
    CREATE ROLE rentkeeper_admin LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- Corrective, and it must stay outside the IF, exactly as in 0003: a database that created
  -- the role from an earlier revision of this migration would keep it NOLOGIN, and the
  -- failure would only appear when an operator tried to connect.
  ALTER ROLE rentkeeper_admin LOGIN;
END $$;
-- +goose StatementEnd

GRANT USAGE ON SCHEMA public TO rentkeeper_app, rentkeeper_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rentkeeper_app, rentkeeper_admin;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentkeeper_app, rentkeeper_admin;

-- Objects created by LATER migrations must be usable without re-granting. This binds to the
-- role running the migration (the object owner) — see server/README.md for why the migration
-- role must stay consistent per database.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rentkeeper_app, rentkeeper_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rentkeeper_app, rentkeeper_admin;

-- The guarantee the whole tenant-isolation model rests on, asserted rather than assumed. If
-- rentkeeper_app could bypass RLS, every isolation test would pass for the wrong reason.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'rentkeeper_app' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'rentkeeper_app must not be SUPERUSER or BYPASSRLS: tenant isolation depends on it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'rentkeeper_app' AND NOT rolcanlogin
  ) THEN
    RAISE EXCEPTION 'rentkeeper_app must be able to log in: the API connects as it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'rentkeeper_admin' AND NOT rolcanlogin
  ) THEN
    RAISE EXCEPTION 'rentkeeper_admin must be able to log in: the admin surface connects as it';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- The grants are reversible; the roles are not, for the reasons above.
--
-- Dropping the roles here would revoke access for every database on the cluster, and would
-- break a deployment that had already switched its DSN to the new names. Role removal stays an
-- explicit operator decision, exactly as in 0003.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rentkeeper_app, rentkeeper_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rentkeeper_app, rentkeeper_admin;
REVOKE USAGE ON SCHEMA public FROM rentkeeper_app, rentkeeper_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM rentkeeper_app, rentkeeper_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM rentkeeper_app, rentkeeper_admin;

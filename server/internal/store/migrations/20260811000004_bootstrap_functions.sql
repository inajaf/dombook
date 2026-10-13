-- +goose Up
-- 0004_bootstrap_functions.sql — the sanctioned RLS exceptions.
--
-- Signup and login run BEFORE a tenant exists or is known:
--
--   * POST /auth/setup  creates the account, so no tenant context can be set yet;
--   * POST /auth/send   writes a code for an email, before anyone is authenticated;
--   * POST /auth/verify reads that code back, still unauthenticated.
--
-- Those operations cannot be authorized by tenant-scoped policies. Leaving the
-- table policies permissive enough to allow them would weaken isolation for every
-- other query, so instead each operation gets a SECURITY DEFINER function that
-- owns exactly that job. These functions are the ONLY way these tables may be
-- touched outside a tenant context.
--
-- Why this is safe: the security decision moves from "which policy allows this
-- row" to "who may call this function". A caller cannot widen a function's
-- behavior — each takes explicit arguments and touches a fixed set of columns.
-- SECURITY DEFINER bypasses RLS only because the defining role owns the tables,
-- and migrations run as the owner.
--
-- search_path is pinned on every function. Without it, a caller able to create
-- objects in a schema earlier on the path could shadow a referenced table and
-- redirect a privileged write — the classic SECURITY DEFINER escalation.

-- ---------------------------------------------------------------------------
-- Account bootstrap
-- ---------------------------------------------------------------------------

-- Drop the superseded three-argument form of bootstrap_account, if present.
--
-- An earlier revision of this migration created an account and its owner in two
-- separate calls, so a database that ran it has a bootstrap_account(uuid, text,
-- text) sitting alongside the current one. PostgreSQL keeps both as overloads
-- rather than replacing them, and "DROP FUNCTION IF EXISTS <name>" fails on an
-- ambiguous name — so an upgrade would either error out or, worse, leave a
-- privileged SECURITY DEFINER function reachable that no longer enforces the
-- atomic account+owner invariant. Dropping the exact old signature makes the
-- migration self-healing instead of depending on a clean database.
DROP FUNCTION IF EXISTS bootstrap_account(uuid, text, text);

-- Creates an account and its first owner in one statement.
--
-- Both rows are pre-tenant: the account *becomes* the tenant, and its owner is the
-- credential that will authenticate against it. Neither insert can satisfy a
-- tenant-scoped policy, and doing them together keeps them atomic — a
-- half-created account with no owner would be unreachable, since nothing could
-- log into it.
CREATE OR REPLACE FUNCTION bootstrap_account(
  p_account_id uuid,
  p_name       text,
  p_plan       text,
  p_user_id    uuid,
  p_email      citext,
  p_user_name  text
) RETURNS TABLE (
  account_id     uuid,
  account_name   text,
  plan           text,
  booking_policy jsonb,
  created_at     timestamptz,
  updated_at     timestamptz,
  user_id        uuid,
  user_email     citext,
  user_name      text,
  user_role      text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Mirrors the column's CHECK constraint so a bad value produces a clear error
  -- here rather than a constraint violation surfaced through the driver.
  IF p_plan NOT IN ('free', 'pro', 'business') THEN
    RAISE EXCEPTION 'unknown plan %', p_plan USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO accounts (id, name, plan) VALUES (p_account_id, p_name, p_plan);

  -- tenant_state is normally created by the accounts trigger; doing it here keeps
  -- the guarantee even if that trigger is dropped, and spares the first sync pull
  -- from handling a missing row.
  INSERT INTO tenant_state (tenant_id, version) VALUES (p_account_id, 0)
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO users (id, account_id, email, name, role)
  VALUES (p_user_id, p_account_id, p_email, p_user_name, 'owner');

  RETURN QUERY
  SELECT a.id, a.name, a.plan, a.booking_policy, a.created_at, a.updated_at,
         u.id, u.email, u.name, u.role
    FROM accounts a
    JOIN users u ON u.account_id = a.id
   WHERE a.id = p_account_id AND u.id = p_user_id;
END
$$;

-- Counts every user in the installation.
--
-- The bootstrap gate on POST /auth/setup asks "is this a brand-new installation?".
-- That is a question about the whole database, asked before any tenant context
-- exists, so the tenant-scoped users policy would report zero rows forever and
-- leave signup permanently open. The function returns a count and nothing else, so
-- it cannot be used to enumerate identities.
CREATE OR REPLACE FUNCTION count_users_for_bootstrap() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM users
$$;

-- ---------------------------------------------------------------------------
-- Login code issuance and consumption
-- ---------------------------------------------------------------------------

-- Records a hashed one-time code for an email. Returns nothing: the caller already
-- knows the code it generated, and echoing it back would put the plaintext on the
-- wire a second time for no benefit.
CREATE OR REPLACE FUNCTION issue_login_code(
  p_id         uuid,
  p_email      citext,
  p_code_hash  text,
  p_expires_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO verification_codes (id, email, code_hash, expires_at)
  VALUES (p_id, p_email, p_code_hash, p_expires_at);
END
$$;

-- Validates and burns a code in a single statement.
--
-- The UPDATE's "used_at IS NULL" predicate is what makes a code single-use under
-- concurrency: two simultaneous verifications cannot both match, because the first
-- sets used_at and the second's predicate no longer holds. A SELECT-then-UPDATE
-- would let a code be replayed once.
CREATE OR REPLACE FUNCTION consume_login_code(
  p_email     citext,
  p_code_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE verification_codes
     SET used_at = now(), updated_at = now()
   WHERE id = (
     SELECT id FROM verification_codes
      WHERE email = p_email
        AND code_hash = p_code_hash
        AND used_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
   );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END
$$;

-- Rate-limit support: how many codes this email requested since an instant.
-- Without a bound here, /auth/send is an unauthenticated endpoint that mails
-- anyone on demand.
CREATE OR REPLACE FUNCTION count_recent_login_codes(
  p_email citext,
  p_since timestamptz
) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer
    FROM verification_codes
   WHERE email = p_email AND created_at > p_since
$$;

-- ---------------------------------------------------------------------------
-- Identity lookup for the login flow
-- ---------------------------------------------------------------------------

-- Resolves an email to its identity, or returns no rows.
--
-- The login flow must answer "does this email belong to a user?" before any session
-- exists, so it cannot go through the users policy. Returning the whole row is
-- deliberate: the caller needs account_id and role to mint a session. The exposure
-- is bounded because an exact email is required.
CREATE OR REPLACE FUNCTION lookup_user_for_login(
  p_email citext
) RETURNS TABLE (
  id         uuid,
  account_id uuid,
  email      citext,
  name       text,
  role       text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, account_id, email, name, role, created_at, updated_at
    FROM users
   WHERE email = p_email
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Execution grants
-- ---------------------------------------------------------------------------

-- Only the application role may call these. PUBLIC is revoked explicitly:
-- PostgreSQL grants EXECUTE to PUBLIC by default, which would expose the bootstrap
-- surface to every role in the database.
REVOKE ALL ON FUNCTION bootstrap_account(uuid, text, text, uuid, citext, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION count_users_for_bootstrap() FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_login_code(uuid, citext, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_login_code(citext, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION count_recent_login_codes(citext, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_user_for_login(citext) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION bootstrap_account(uuid, text, text, uuid, citext, text) TO dombook_app;
GRANT EXECUTE ON FUNCTION count_users_for_bootstrap() TO dombook_app;
GRANT EXECUTE ON FUNCTION issue_login_code(uuid, citext, text, timestamptz) TO dombook_app;
GRANT EXECUTE ON FUNCTION consume_login_code(citext, text) TO dombook_app;
GRANT EXECUTE ON FUNCTION count_recent_login_codes(citext, timestamptz) TO dombook_app;
GRANT EXECUTE ON FUNCTION lookup_user_for_login(citext) TO dombook_app;

-- +goose Down
-- Dropping these functions restores deny-all on verification_codes and removes the
-- only path to account bootstrap, so a rollback leaves the database unable to
-- accept new signups or logins until the code is rolled back too. That is the
-- correct direction for a security control: fail closed.
DROP FUNCTION IF EXISTS lookup_user_for_login(citext);
DROP FUNCTION IF EXISTS count_recent_login_codes(citext, timestamptz);
DROP FUNCTION IF EXISTS consume_login_code(citext, text);
DROP FUNCTION IF EXISTS issue_login_code(uuid, citext, text, timestamptz);
DROP FUNCTION IF EXISTS count_users_for_bootstrap();
DROP FUNCTION IF EXISTS bootstrap_account(uuid, text, text, uuid, citext, text);
-- The superseded form is dropped too, so a rollback leaves neither behind.
DROP FUNCTION IF EXISTS bootstrap_account(uuid, text, text);

-- +goose Up
-- 0005_auth_flow_functions.sql — pre-tenant operations on the auth tables.
--
-- 0004 covered signup and login. Three more operations genuinely run before a
-- tenant is known, and each needs the same treatment for the same reason:
--
--   1. Session validation. A request arrives with a JWT whose jti is known but
--      whose account is not — the account is *read from* the session row. Under
--      the sessions policy an unscoped lookup matches nothing, so the server could
--      never resolve a token at all. This is the chicken-and-egg case that makes a
--      SECURITY DEFINER lookup the only workable design.
--   2. Session creation. Minting a session happens while the client is still
--      unauthenticated (it is the act of authenticating), so no tenant context
--      exists yet.
--   3. Invite creation. An owner invites an email address that has no user row
--      yet; the insert is authorized by the inviter's role, which the handler
--      checks, and the row must be attributed to the inviter's account.
--
-- Every function pins search_path and revokes PUBLIC EXECUTE, like 0004.

-- ---------------------------------------------------------------------------
-- Session resolution and lifecycle
-- ---------------------------------------------------------------------------

-- Returns the identity behind a live session, for a jti only.
--
-- This is the token-validation path: the account id is an OUTPUT here, not an
-- input, so no tenant context can exist when it runs. The function returns only
-- live (unrevoked, unexpired) sessions, so a revoked session produces no rows and
-- cannot be distinguished from an unknown one by the caller.
CREATE OR REPLACE FUNCTION lookup_session_for_auth(
  p_session_id uuid
) RETURNS TABLE (
  session_id  uuid,
  user_id     uuid,
  account_id  uuid,
  role        text,
  email       citext,
  user_name   text,
  account_name text,
  plan        text,
  expires_at  timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, u.id, s.account_id, u.role, u.email, u.name, a.name, a.plan, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN accounts a ON a.id = s.account_id
   WHERE s.id = p_session_id
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
   LIMIT 1
$$;

-- Records an issued access token. The client is not authenticated yet — this IS
-- the authentication — so the caller supplies the identity it just verified.
CREATE OR REPLACE FUNCTION create_auth_session(
  p_session_id uuid,
  p_user_id    uuid,
  p_account_id uuid,
  p_device_id  uuid,
  p_expires_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO sessions (id, user_id, account_id, device_id, expires_at)
  VALUES (p_session_id, p_user_id, p_account_id, p_device_id, p_expires_at);
END
$$;

-- Revokes one session by jti. Called on logout, where the account is known from
-- the token but the operation must still work if the row is already gone.
CREATE OR REPLACE FUNCTION revoke_auth_session(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE sessions SET revoked_at = now(), updated_at = now()
   WHERE id = p_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END
$$;

-- Revokes every live session for a user ("sign out everywhere").
--
-- Separate from the single-session revoke because its argument is a user id, and
-- overloading one function on both ids would make a mix-up silently revoke the
-- wrong scope — the failure mode here is security-relevant, so the two operations
-- get two names.
CREATE OR REPLACE FUNCTION revoke_user_sessions(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE sessions SET revoked_at = now(), updated_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

-- Creates a pending invitation.
--
-- The invited email has no user row, so the insert cannot be authorized by the
-- users policy; it is authorized by the inviter's role, which the handler enforces
-- before calling this. The row is attributed to the inviter's account, which the
-- caller must pass explicitly.
CREATE OR REPLACE FUNCTION create_login_invite(
  p_id         uuid,
  p_account_id uuid,
  p_email      citext,
  p_role       text,
  p_token_hash text,
  p_created_by uuid,
  p_expires_at timestamptz
) RETURNS TABLE (
  id         uuid,
  account_id uuid,
  email      citext,
  role       text,
  status     text,
  expires_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Owners must not be creatable by invitation: an invite that could grant owner
  -- would let any admin escalate to full account control.
  IF p_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'invites may only grant admin or staff, got %', p_role
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  INSERT INTO invites (id, account_id, email, role, token_hash, created_by, expires_at)
  VALUES (p_id, p_account_id, p_email, p_role, p_token_hash, p_created_by, p_expires_at)
  RETURNING invites.id, invites.account_id, invites.email, invites.role,
            invites.status, invites.expires_at, invites.created_at;
END
$$;

-- Finds a pending, unexpired invitation by email, for a caller with no session.
--
-- /auth/send must answer "is this email loginable?" for an address that has neither
-- a user row nor a session, and /auth/verify uses this to convert an invitation into
-- membership. Both run before the invited person is authenticated, so neither can
-- supply a tenant context. Returning account_id is the whole point: it is what the
-- caller will adopt as the tenant once the invite is accepted.
CREATE OR REPLACE FUNCTION lookup_pending_invite(
  p_email citext
) RETURNS TABLE (
  id         uuid,
  account_id uuid,
  email      citext,
  role       text,
  token_hash text,
  created_by uuid,
  status     text,
  expires_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.account_id, i.email, i.role, i.token_hash, i.created_by,
         i.status, i.expires_at, i.created_at
    FROM invites i
   WHERE i.email = p_email
     AND i.status = 'pending'
     AND i.expires_at > now()
     AND i.deleted_at IS NULL
   ORDER BY i.created_at DESC
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION lookup_session_for_auth(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_auth_session(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_auth_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_user_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_login_invite(uuid, uuid, citext, text, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_pending_invite(citext) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION lookup_session_for_auth(uuid) TO dombook_app;
GRANT EXECUTE ON FUNCTION create_auth_session(uuid, uuid, uuid, uuid, timestamptz) TO dombook_app;
GRANT EXECUTE ON FUNCTION revoke_auth_session(uuid) TO dombook_app;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(uuid) TO dombook_app;
GRANT EXECUTE ON FUNCTION create_login_invite(uuid, uuid, citext, text, text, uuid, timestamptz) TO dombook_app;
GRANT EXECUTE ON FUNCTION lookup_pending_invite(citext) TO dombook_app;

-- +goose Down
DROP FUNCTION IF EXISTS lookup_pending_invite(citext);
DROP FUNCTION IF EXISTS create_login_invite(uuid, uuid, citext, text, text, uuid, timestamptz);
DROP FUNCTION IF EXISTS revoke_user_sessions(uuid);
DROP FUNCTION IF EXISTS revoke_auth_session(uuid);
DROP FUNCTION IF EXISTS create_auth_session(uuid, uuid, uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS lookup_session_for_auth(uuid);

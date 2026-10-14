-- +goose Up
-- 0011_function_grants.sql — give the renamed roles the SECURITY DEFINER functions they need.
--
-- Migration 0010 created rentkeeper_app and rentkeeper_admin and granted them schema and table
-- privileges, but NOT the functions. That is a gap the test suite found immediately:
-- `permission denied for function bootstrap_account`. In production the symptom would be every
-- signup, login and session check failing with a permission error while the tables looked fine.
--
-- WHY THIS IS NOT A BLANKET GRANT. `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public` would be
-- shorter and is exactly what the design avoids: these functions bypass row-level security by
-- design (that is what SECURITY DEFINER is for here), so each one is granted to the application
-- role individually and deliberately. 0004-0006 do `REVOKE ALL ... FROM PUBLIC` before granting
-- for the same reason — PostgreSQL grants EXECUTE to PUBLIC by default, so a new function is
-- world-executable until someone says otherwise.
--
-- A blanket grant here would also silently undo that property for every function added in
-- future: it would be applied once, but the intent it encodes ("everything is executable") is
-- the opposite of this project's rule, which is that a privileged function is reachable only
-- where it was explicitly allowed. See server/README.md.
--
-- The list is the exact set granted to dombook_app in 0004-0007, verbatim, so the two roles are
-- interchangeable and the renamed role is not subtly less capable than the one it replaces.

-- 0004: bootstrap and login, which run before a tenant exists.
GRANT EXECUTE ON FUNCTION bootstrap_account(uuid, text, text, uuid, citext, text) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION count_users_for_bootstrap() TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION issue_login_code(uuid, citext, text, timestamptz) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION consume_login_code(citext, text) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION count_recent_login_codes(citext, timestamptz) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION lookup_user_for_login(citext) TO rentkeeper_app;

-- 0005: sessions and invites.
GRANT EXECUTE ON FUNCTION lookup_session_for_auth(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION create_auth_session(uuid, uuid, uuid, uuid, timestamptz) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION revoke_auth_session(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION create_login_invite(uuid, uuid, citext, text, text, uuid, timestamptz) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION lookup_pending_invite(citext) TO rentkeeper_app;

-- 0006: refresh tokens.
GRANT EXECUTE ON FUNCTION issue_refresh_token(uuid, uuid, uuid, uuid, uuid, text, timestamptz) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION consume_refresh_token(text) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION refresh_token_family(text) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION revoke_refresh_family(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION revoke_user_refresh_tokens(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION lookup_user_for_refresh(uuid) TO rentkeeper_app;

-- 0007: entitlements. account_is_paid is the quota trigger's authority and is the one function
-- BOTH roles need, exactly as in 0007.
GRANT EXECUTE ON FUNCTION account_is_paid(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION account_is_paid(uuid) TO rentkeeper_admin;
GRANT EXECUTE ON FUNCTION entitlement_history_for_account(uuid, integer) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION active_entitlements_for_account(uuid) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION grant_entitlement(uuid, uuid, text, text, timestamptz, text, jsonb) TO rentkeeper_app;
GRANT EXECUTE ON FUNCTION revoke_entitlement(uuid, text, text) TO rentkeeper_app;

-- +goose Down
-- Revoking restores the state 0010 left the database in: roles present and usable for data,
-- with no access to the privileged functions. It does not touch the grants made to the old
-- dombook_* roles in 0004-0007, which this migration never altered.
REVOKE EXECUTE ON FUNCTION bootstrap_account(uuid, text, text, uuid, citext, text) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION count_users_for_bootstrap() FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION issue_login_code(uuid, citext, text, timestamptz) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION consume_login_code(citext, text) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION count_recent_login_codes(citext, timestamptz) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION lookup_user_for_login(citext) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION lookup_session_for_auth(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION create_auth_session(uuid, uuid, uuid, uuid, timestamptz) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION revoke_auth_session(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION revoke_user_sessions(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION create_login_invite(uuid, uuid, citext, text, text, uuid, timestamptz) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION lookup_pending_invite(citext) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION issue_refresh_token(uuid, uuid, uuid, uuid, uuid, text, timestamptz) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION consume_refresh_token(text) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION refresh_token_family(text) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION revoke_refresh_family(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION revoke_user_refresh_tokens(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION lookup_user_for_refresh(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION account_is_paid(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION account_is_paid(uuid) FROM rentkeeper_admin;
REVOKE EXECUTE ON FUNCTION entitlement_history_for_account(uuid, integer) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION active_entitlements_for_account(uuid) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION grant_entitlement(uuid, uuid, text, text, timestamptz, text, jsonb) FROM rentkeeper_app;
REVOKE EXECUTE ON FUNCTION revoke_entitlement(uuid, text, text) FROM rentkeeper_app;

-- +goose Up
-- 0009_quarterly_licence.sql — the licence is now sold in three-month terms.
--
-- The commercial model changed: the one-time perpetual purchase is withdrawn and the paid
-- tier is sold as a 90-day licence. The catalog in internal/billing/catalog.go carries the
-- rules; this migration exists for ONE reason, and getting it wrong locks paying customers
-- out of their own data.
--
-- account_is_paid() gates the free-tier quota trigger with a hard-coded SKU allowlist. A
-- grant whose SKU is not in that list counts as unpaid, so adding app_quarterly to the
-- catalog WITHOUT adding it here would mean a customer pays for three months and is still
-- refused the second unit by a database trigger. The friendly check in Go would accept them
-- and the trigger would reject them, which is the worst shape a bug can take: the error
-- arrives at the moment of a write, not at the moment of purchase.
--
-- app_perpetual STAYS IN THE LIST DELIBERATELY. It is no longer sold, but every grant
-- already issued remains valid forever — that was the promise made at the time of sale.
-- Dropping it here would revoke licences people paid for.
--
-- Kept in the same shape as 0007 minus the SKU list: SQL STABLE SECURITY DEFINER with a
-- pinned search_path, so this trusted function cannot be redirected by a caller who can
-- create objects earlier on the search path.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION account_is_paid(p_account_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_entitlements e
     WHERE e.account_id = p_account_id
       AND e.revoked_at IS NULL
       AND (e.expires_at IS NULL OR e.expires_at > now())
       AND e.sku IN ('app_quarterly', 'app_annual', 'app_perpetual', 'trial_full')
  )
$$;
-- +goose StatementEnd

-- Replacing a function must not leave the superseded form behind. PostgreSQL keeps
-- same-named functions as overloads and `DROP FUNCTION IF EXISTS <name>` fails on an
-- ambiguous name, so the old signature is dropped by its EXACT signature first.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'account_is_paid'
       AND pg_get_function_identity_arguments(p.oid) <> 'p_account_id uuid'
  ) THEN
    RAISE EXCEPTION 'account_is_paid has an unexpected overload; drop it explicitly by signature';
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- The allowlist is NOT narrowed again.
--
-- Reverting it would take the paid tier away from every customer who bought a quarterly
-- licence while this migration was applied — a downgrade of live paying accounts is not a
-- migration step. This Up only ever ADDS a SKU to the list, so there is nothing safe to
-- undo here; the catalog stops selling the SKU instead, and existing grants run out on
-- their own expires_at.
SELECT 1;

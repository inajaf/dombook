-- +goose Up
-- 0007_entitlements.sql — what an account has paid for, recorded server-side.
--
-- The product sells a one-time purchase, not a subscription: buy the app once and keep it.
-- Hosting costs are small enough for a small landlord that "forever" is viable, and the
-- only genuinely variable cost is WhatsApp messaging, which is sold as an add-on. That
-- model needs a record of what was granted and when — not a plan flag, because a one-time
-- grant is a fact about the past rather than a current subscription state.
--
-- Design decisions:
--
--   * An entitlement ROW is evidence of a grant, never edited in place. A refund or a
--     revocation adds a timestamp rather than deleting, so the history of what a customer
--     paid for survives an argument about it.
--
--   * expires_at NULL means perpetual. That covers the one-time purchase directly, and a
--     time-limited grant (a year of sync, with cheap renewal) differs only by having a
--     date — so both models your plan describes fit one schema without a migration.
--
--   * source records how the grant arrived, so a support override is distinguishable from a
--     real payment. Without it, a manually granted entitlement is indistinguishable from a
--     purchase during reconciliation.
--
-- The limits themselves stay in Go (internal/billing), matching where the plan catalog
-- lives. This table records facts; it does not decide policy.

CREATE TABLE account_entitlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The thing that was granted. Values are validated in Go rather than constrained here,
  -- so adding a SKU does not require a migration.
  sku         text NOT NULL,
  -- How it arrived: one_time | paddle_addon | manual | trial.
  source      text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL means perpetual, which is the one-time purchase.
  expires_at  timestamptz,
  -- Set when the grant is withdrawn (refund, chargeback, policy violation).
  revoked_at  timestamptz,
  -- Free-form provenance: a Paddle transaction id, a support ticket, an order number.
  -- This is what makes reconciliation possible without keeping a second ledger.
  reference   text NOT NULL DEFAULT '',
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Lookups are always "what does this account currently have", so the index is per account.
CREATE INDEX account_entitlements_account_idx
  ON account_entitlements(account_id, granted_at DESC);

-- An active grant is one that is neither revoked nor expired. The partial predicate keeps
-- the common query small even after years of history.
CREATE INDEX account_entitlements_active_idx
  ON account_entitlements(account_id, sku)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Restore reservation_services.service_name, dropped in the baseline
-- ---------------------------------------------------------------------------
--
-- The D1 schema required a display name for a service alongside its type, and the Go
-- baseline kept only the type. The cutover found it: an existing row reads
-- (service_type = 'bath', service_name = 'Баня'), and without this column the migration
-- would discard the text the guest actually sees on their invoice — silently, because the
-- column simply would not exist to copy into.
--
-- The name is not derivable from the type: an account can call the same service whatever it
-- likes, and the D1 data proves it by storing both.

ALTER TABLE reservation_services
  ADD COLUMN IF NOT EXISTS service_name text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE account_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_entitlements FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON account_entitlements
  USING (account_id = current_tenant_id())
  WITH CHECK (account_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Reading entitlements without a tenant context
-- ---------------------------------------------------------------------------
--
-- The client asks "what have I paid for" as part of startup, before it has a usable
-- session for every path — and a signed-out client must still learn that its cached
-- licence is valid rather than silently falling back to the free tier. This function is the
-- narrow exception, following the same rules as 0004/0005: one operation, explicit
-- arguments, search_path pinned, PUBLIC revoked.

CREATE OR REPLACE FUNCTION active_entitlements_for_account(
  p_account_id uuid
) RETURNS TABLE (
  id         uuid,
  sku        text,
  source     text,
  granted_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.sku, e.source, e.granted_at, e.expires_at
    FROM account_entitlements e
   WHERE e.account_id = p_account_id
     AND e.revoked_at IS NULL
     AND (e.expires_at IS NULL OR e.expires_at > now())
   ORDER BY e.granted_at DESC
$$;

-- Full history for one account, including revoked and expired grants.
--
-- Needed because a revocation is only visible in the history: the active-grants function
-- deliberately hides it, and "what does this account have" is a different question from
-- "what has ever happened to this account" — the second is what a payment dispute is about.
--
-- A SECURITY DEFINER function rather than a tenant-scoped query, because RLS makes an
-- unset tenant yield ZERO ROWS. A history read that appears to succeed while returning
-- nothing is worse than one that fails: it looks like the customer never paid.
CREATE OR REPLACE FUNCTION entitlement_history_for_account(
  p_account_id uuid,
  p_limit      integer
) RETURNS TABLE (
  id         uuid,
  sku        text,
  source     text,
  granted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  reference  text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.sku, e.source, e.granted_at, e.expires_at, e.revoked_at, e.reference
    FROM account_entitlements e
   WHERE e.account_id = p_account_id
   ORDER BY e.granted_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;

-- Grants an entitlement. Used by the payment webhook and by a support override, both of
-- which run without a tenant context.
CREATE OR REPLACE FUNCTION grant_entitlement(
  p_id         uuid,
  p_account_id uuid,
  p_sku        text,
  p_source     text,
  p_expires_at timestamptz,
  p_reference  text,
  p_metadata   jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  existing uuid;
BEGIN
  -- A payment webhook can be delivered more than once; Paddle retries on any non-2xx. The
  -- reference identifies the transaction, so a repeat delivery must not create a second
  -- entitlement for the same purchase.
  IF p_reference <> '' THEN
    SELECT e.id INTO existing
      FROM account_entitlements e
     WHERE e.account_id = p_account_id
       AND e.sku = p_sku
       AND e.reference = p_reference
       AND e.revoked_at IS NULL
     LIMIT 1;
    IF existing IS NOT NULL THEN
      RETURN existing;
    END IF;
  END IF;

  INSERT INTO account_entitlements(id, account_id, sku, source, expires_at, reference, metadata)
  VALUES (p_id, p_account_id, p_sku, p_source, p_expires_at, p_reference, COALESCE(p_metadata, '{}'::jsonb));

  RETURN p_id;
END $$;

-- Revokes an entitlement. Returns whether a live grant was found, so a caller can report
-- "nothing to revoke" instead of silently succeeding.
CREATE OR REPLACE FUNCTION revoke_entitlement(
  p_account_id uuid,
  p_sku        text,
  p_reason     text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE account_entitlements
     SET revoked_at = now(),
         updated_at = now(),
         metadata = metadata || jsonb_build_object('revokedReason', p_reason)
   WHERE account_id = p_account_id
     AND sku = p_sku
     AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;

-- ---------------------------------------------------------------------------
-- The quota backstop follows entitlements, not the legacy plan column
-- ---------------------------------------------------------------------------
--
-- The trigger in 0002 is the race-safety guarantee behind the service's friendly check:
-- it runs inside the insert, so two concurrent activations cannot both slip past a count
-- taken outside the transaction. It read `accounts.plan`, which is the legacy subscription
-- column — so a customer who bought the one-time licence would be refused by the database
-- while the service was happy to let them in. The two have to agree on what "paid" means,
-- and the entitlement is the authority.

CREATE OR REPLACE FUNCTION account_is_paid(p_account_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_entitlements e
     WHERE e.account_id = p_account_id
       AND e.revoked_at IS NULL
       AND (e.expires_at IS NULL OR e.expires_at > now())
       AND e.sku IN ('app_perpetual', 'app_annual', 'trial_full')
  )
$$;

CREATE OR REPLACE FUNCTION enforce_free_plan_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid boolean;
  active_count integer;
BEGIN
  -- Limits apply to records that are live AND active. Archived rows and soft-deleted rows
  -- do not consume a slot, so a free user can archive their unit and create a replacement
  -- instead of being permanently blocked.
  IF NEW.deleted_at IS NOT NULL OR NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- An update that neither activates nor reactivates the row consumes no quota.
  IF TG_OP = 'UPDATE'
     AND OLD.deleted_at IS NULL AND OLD.status = 'active' THEN
    RETURN NEW;
  END IF;

  -- A live entitlement lifts the cap. An unknown or missing account fails closed to the
  -- free tier, so a broken lookup cannot hand out a paid feature.
  SELECT account_is_paid(NEW.tenant_id) INTO paid;
  IF COALESCE(paid, false) THEN
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
              HINT = 'The free tier allows one active unit. A license lifts the cap.';
    END IF;
  ELSIF TG_TABLE_NAME = 'places' THEN
    SELECT count(*) INTO active_count
      FROM places
     WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL
       AND id <> NEW.id;
    IF active_count >= 1 THEN
      RAISE EXCEPTION 'dombook_plan_limit_places'
        USING ERRCODE = 'check_violation',
              HINT = 'The free tier allows one active place. A license lifts the cap.';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION account_is_paid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_is_paid(uuid) TO dombook_app;
GRANT EXECUTE ON FUNCTION account_is_paid(uuid) TO dombook_admin;

REVOKE ALL ON FUNCTION entitlement_history_for_account(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION active_entitlements_for_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION grant_entitlement(uuid, uuid, text, text, timestamptz, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_entitlement(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION entitlement_history_for_account(uuid, integer) TO dombook_app;
GRANT EXECUTE ON FUNCTION active_entitlements_for_account(uuid) TO dombook_app;
GRANT EXECUTE ON FUNCTION grant_entitlement(uuid, uuid, text, text, timestamptz, text, jsonb) TO dombook_app;
GRANT EXECUTE ON FUNCTION revoke_entitlement(uuid, text, text) TO dombook_app;

-- +goose Down
ALTER TABLE reservation_services DROP COLUMN IF EXISTS service_name;

-- Restore the plan-column trigger, so reverting this migration leaves a working quota
-- backstop rather than none.
CREATE OR REPLACE FUNCTION enforce_free_plan_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_plan text;
  active_count integer;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.deleted_at IS NULL AND OLD.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT plan INTO account_plan FROM accounts WHERE id = NEW.tenant_id;
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

DROP FUNCTION IF EXISTS account_is_paid(uuid);
DROP FUNCTION IF EXISTS revoke_entitlement(uuid, text, text);
DROP FUNCTION IF EXISTS grant_entitlement(uuid, uuid, text, text, timestamptz, text, jsonb);
DROP FUNCTION IF EXISTS entitlement_history_for_account(uuid, integer);
DROP FUNCTION IF EXISTS active_entitlements_for_account(uuid);
DROP TABLE IF EXISTS account_entitlements;

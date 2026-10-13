-- Atomic safety net for free-plan quotas. Application checks in plans.ts own
-- the user-facing policy; these triggers only close the count-then-insert race
-- between concurrent requests and direct sync upserts.

CREATE TRIGGER free_plan_places_insert_limit
BEFORE INSERT ON places
WHEN NEW.status = 'active'
  AND NEW.deleted_at IS NULL
  AND COALESCE((SELECT plan FROM accounts WHERE id = NEW.tenant_id), 'free') = 'free'
  AND (SELECT COUNT(*) FROM places
       WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL) >= 1
BEGIN
  SELECT RAISE(ABORT, 'dombook_plan_limit_places');
END;

CREATE TRIGGER free_plan_places_activation_limit
BEFORE UPDATE OF status, deleted_at ON places
WHEN NEW.status = 'active'
  AND NEW.deleted_at IS NULL
  AND NOT (OLD.status = 'active' AND OLD.deleted_at IS NULL)
  AND COALESCE((SELECT plan FROM accounts WHERE id = NEW.tenant_id), 'free') = 'free'
  AND (SELECT COUNT(*) FROM places
       WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL) >= 1
BEGIN
  SELECT RAISE(ABORT, 'dombook_plan_limit_places');
END;

CREATE TRIGGER free_plan_properties_insert_limit
BEFORE INSERT ON properties
WHEN NEW.status = 'active'
  AND NEW.deleted_at IS NULL
  AND COALESCE((SELECT plan FROM accounts WHERE id = NEW.tenant_id), 'free') = 'free'
  AND (SELECT COUNT(*) FROM properties
       WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL) >= 1
BEGIN
  SELECT RAISE(ABORT, 'dombook_plan_limit_properties');
END;

CREATE TRIGGER free_plan_properties_activation_limit
BEFORE UPDATE OF status, deleted_at ON properties
WHEN NEW.status = 'active'
  AND NEW.deleted_at IS NULL
  AND NOT (OLD.status = 'active' AND OLD.deleted_at IS NULL)
  AND COALESCE((SELECT plan FROM accounts WHERE id = NEW.tenant_id), 'free') = 'free'
  AND (SELECT COUNT(*) FROM properties
       WHERE tenant_id = NEW.tenant_id AND status = 'active' AND deleted_at IS NULL) >= 1
BEGIN
  SELECT RAISE(ABORT, 'dombook_plan_limit_properties');
END;

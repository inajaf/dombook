-- +goose Up
-- 0008_rentals.sql — long-term rentals alongside nightly stays.
--
-- A tenancy is NOT a new entity. It is a reservation with a long date range, which is what
-- lets the single exclusion constraint on `reservations` enforce availability across both
-- modes: a tenancy blocks short stays on the same unit and is blocked by them, with no second
-- availability check that could drift out of step. The alternative — a separate `tenancies`
-- table — would need the constraint duplicated and kept in sync across two tables, and a bug
-- in that duplication is a double-sold unit.
--
-- So this migration only ADDS fields. It introduces no table, no enum type, and no new
-- constraint.

-- A unit's monthly rate. Zero means "not offered for rent", which is how the Rentals screen
-- decides what to offer rather than needing a separate availability flag: a flag and a rate
-- could disagree, and then the UI would offer a let with no price.
ALTER TABLE units ADD COLUMN monthly_rate_minor bigint NOT NULL DEFAULT 0
  CHECK (monthly_rate_minor >= 0);

-- Which kind of booking this is. Stored rather than derived from the stay length, because an
-- owner may agree a monthly rate on a three-month let, and deriving it would flip that tenancy
-- into a stay the moment its term was edited below the threshold.
--
-- Defaulting to 'stay' is what makes this migration safe for existing rows and for any client
-- that does not yet send the field.
ALTER TABLE reservations ADD COLUMN booking_kind text NOT NULL DEFAULT 'stay'
  CHECK (booking_kind IN ('stay', 'rental'));

-- The agreed rent, captured on the reservation for the same reason nightly_rate_minor is: a
-- later change to the unit's price must not silently reprice an existing lease.
ALTER TABLE reservations ADD COLUMN monthly_rate_minor bigint NOT NULL DEFAULT 0
  CHECK (monthly_rate_minor >= 0);

-- Meter readings for the tenancy, e.g. {"electricity": {"start": 1200, "end": 1340}}.
--
-- jsonb rather than columns because the set of utilities varies by building and country: a
-- schema with fixed `electricity_start`/`gas_end` columns would need a migration for every
-- utility an owner wants to track, and most rows would leave them NULL. The readings are
-- reference data typed in once per tenancy; nothing is computed from them, so the loss of
-- column-level constraints costs nothing that is not already validated on write.
ALTER TABLE reservations ADD COLUMN meter_readings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Rentals are looked up as a group far more often than stays are filtered out, so a partial
-- index keeps the Rentals screen's query small as the stay history grows.
CREATE INDEX reservations_rental_idx
  ON reservations(tenant_id, check_in_date)
  WHERE booking_kind = 'rental' AND deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS reservations_rental_idx;
ALTER TABLE reservations DROP COLUMN IF EXISTS meter_readings;
ALTER TABLE reservations DROP COLUMN IF EXISTS monthly_rate_minor;
ALTER TABLE reservations DROP COLUMN IF EXISTS booking_kind;
ALTER TABLE units DROP COLUMN IF EXISTS monthly_rate_minor;

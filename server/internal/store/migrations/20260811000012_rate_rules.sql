-- +goose Up
-- 0012_rate_rules.sql — flexible pricing: seasons, length discounts, and the working behind an
-- amount that was charged.
--
-- Two columns, both client-authored text. The server neither parses nor applies them on the sync
-- path: a client computes the amount and pushes the row, exactly as it already did with the
-- nightly and monthly rates. Parsing them here would create a second implementation of a pricing
-- rule in a different language against a different clock, which is the drift
-- fixtures/pricing-cases.json exists to prevent.
--
-- It is stored as TEXT rather than jsonb because the client's column is TEXT and the value round
-- trips byte for byte. A jsonb column would come back re-serialised — key order and number
-- formatting are PostgreSQL's choice, not the client's — and the client compares the pulled value
-- against what it stored to decide whether a row changed.

-- A unit's pricing rules: {"seasons":[…],"stayDiscounts":[…],"tenancyDiscounts":[…]}. The shape is
-- owned by src/domain/booking/pricing.cjs (mirrored in Go). The empty object is the rule set that
-- prices exactly as the product did before seasons existed, which is what makes this migration
-- safe for every existing row: no booking is repriced by adding the column.
ALTER TABLE units ADD COLUMN rate_rules text NOT NULL DEFAULT '{}';

-- How an amount was arrived at: the nights, the season rates that applied, the discount.
--
-- Stored rather than recomputed because a unit's rates and seasons change after the booking, and
-- an invoice that derives a different breakdown from the amount actually charged is worse than an
-- invoice with no breakdown at all. A negotiated amount stores '{}' — there is no working to show
-- for a figure that was agreed rather than calculated.
ALTER TABLE reservations ADD COLUMN rate_breakdown text NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE reservations DROP COLUMN IF EXISTS rate_breakdown;
ALTER TABLE units DROP COLUMN IF EXISTS rate_rules;

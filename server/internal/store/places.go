package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/httpapi"
)

// This file holds CRUD for places and units. Every method takes the tenant explicitly
// and runs inside WithTenant, so the RLS policies apply to the write rather than
// relying on a WHERE clause being remembered.
//
// Mutations also bump the tenant sync version in the SAME transaction. That ordering
// matters: the sync watermark must never advance past a change that was not
// committed, and a committed change must never be invisible to a pull. Doing the bump
// separately would let a crash in between produce exactly those states.

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

// placeColumns is shared by every place query so the scan order cannot drift from
// the select list.
const placeColumns = `id, tenant_id, name, address, has_food_service,
	breakfast_price_minor, lunch_price_minor, dinner_price_minor,
	status, notes, created_at, updated_at, deleted_at, version, last_writer`

func scanPlace(row rowScanner) (*Place, error) {
	var place Place
	err := row.Scan(
		&place.ID, &place.TenantID, &place.Name, &place.Address, &place.HasFoodService,
		&place.BreakfastPriceMinor, &place.LunchPriceMinor, &place.DinnerPriceMinor,
		&place.Status, &place.Notes, &place.CreatedAt, &place.UpdatedAt,
		&place.DeletedAt, &place.Version, &place.LastWriter,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &place, nil
}

// ListPlaces returns the tenant's places, newest first.
func (s *Store) ListPlaces(ctx context.Context, tenantID string) ([]Place, error) {
	var places []Place
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+placeColumns+`
			FROM places WHERE deleted_at IS NULL ORDER BY created_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			place, err := scanPlace(rows)
			if err != nil {
				return err
			}
			places = append(places, *place)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return places, nil
}

// GetPlace loads one place. A row belonging to another tenant is indistinguishable
// from a missing one, because RLS filters it out before the id comparison runs.
func (s *Store) GetPlace(ctx context.Context, tenantID, placeID string) (*Place, error) {
	var place *Place
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		var err error
		place, err = scanPlace(tx.QueryRow(ctx,
			`SELECT `+placeColumns+` FROM places WHERE id = $1 AND deleted_at IS NULL`, placeID))
		return err
	})
	if err != nil {
		return nil, err
	}
	return place, nil
}

// CreatePlace inserts a place and returns it with its assigned sync version.
func (s *Store) CreatePlace(ctx context.Context, tenantID string, input *domain.PlaceInput, writer string) (*Place, error) {
	id, err := NewID()
	if err != nil {
		return nil, err
	}

	var place *Place
	err = s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}

		place, err = scanPlace(tx.QueryRow(ctx, `
			INSERT INTO places(id, tenant_id, name, address, has_food_service,
				breakfast_price_minor, lunch_price_minor, dinner_price_minor,
				status, notes, version, last_writer)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
			RETURNING `+placeColumns,
			id, tenantID, input.Name, input.Address, input.HasFoodService,
			input.BreakfastPriceMinor, input.LunchPriceMinor, input.DinnerPriceMinor,
			input.Status, input.Notes, version, writer))
		if err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "place", place.ID, "create", writer)
	})
	if err != nil {
		// The free-plan trigger is the atomic backstop for the quota check the caller
		// performed earlier; translate it so the race loser sees the same message.
		if constraintErr := planLimitError(err, "places", 1); constraintErr != nil {
			return nil, constraintErr
		}
		return nil, TranslateError(err)
	}
	return place, nil
}

// UpdatePlace replaces a place's editable fields.
func (s *Store) UpdatePlace(ctx context.Context, tenantID, placeID string, input *domain.PlaceInput, writer string) (*Place, error) {
	var place *Place
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		place, err = scanPlace(tx.QueryRow(ctx, `
			UPDATE places SET
				name = $2, address = $3, has_food_service = $4,
				breakfast_price_minor = $5, lunch_price_minor = $6, dinner_price_minor = $7,
				status = $8, notes = $9, updated_at = now(),
				version = $10, last_writer = $11
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING `+placeColumns,
			placeID, input.Name, input.Address, input.HasFoodService,
			input.BreakfastPriceMinor, input.LunchPriceMinor, input.DinnerPriceMinor,
			input.Status, input.Notes, version, writer))
		if err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "place", placeID, "update", writer)
	})
	if err != nil {
		if constraintErr := planLimitError(err, "places", 1); constraintErr != nil {
			return nil, constraintErr
		}
		return nil, TranslateError(err)
	}
	return place, nil
}

// SetPlaceStatus archives or restores a place.
//
// Archiving frees a free-plan slot, so the restore path can hit the quota trigger;
// that is intentional and matches the documented semantics (archived rows do not count
// toward a plan's limit).
func (s *Store) SetPlaceStatus(ctx context.Context, tenantID, placeID, status, writer string) (*Place, error) {
	var place *Place
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		place, err = scanPlace(tx.QueryRow(ctx, `
			UPDATE places SET status = $2, updated_at = now(), version = $3, last_writer = $4
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING `+placeColumns, placeID, status, version, writer))
		if err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "place", placeID, "status:"+status, writer)
	})
	if err != nil {
		if constraintErr := planLimitError(err, "places", 1); constraintErr != nil {
			return nil, constraintErr
		}
		return nil, TranslateError(err)
	}
	return place, nil
}

// SoftDeletePlace marks a place deleted.
//
// Soft, not hard: sync replicas need a tombstone to learn that the row is gone.
// A hard delete would leave every offline client holding a row the server no longer
// knows about, and the next push would resurrect it.
func (s *Store) SoftDeletePlace(ctx context.Context, tenantID, placeID, writer string) error {
	return s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE places SET deleted_at = now(), updated_at = now(), version = $3, last_writer = $4
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, placeID, tenantID, version, writer)
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return s.audit(ctx, tx, tenantID, "place", placeID, "delete", writer)
	})
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const unitColumns = `id, tenant_id, place_id, kind, name, location, capacity,
	base_price_minor, deposit_minor, monthly_rate_minor, currency, check_in_time, check_out_time,
	status, notes, created_at, updated_at, deleted_at, version, last_writer`

func scanUnit(row rowScanner) (*Unit, error) {
	var unit Unit
	err := row.Scan(
		&unit.ID, &unit.TenantID, &unit.PlaceID, &unit.Kind, &unit.Name, &unit.Location,
		&unit.Capacity, &unit.BasePriceMinor, &unit.DepositMinor, &unit.MonthlyRateMinor,
		&unit.Currency,
		&unit.CheckInTime, &unit.CheckOutTime, &unit.Status, &unit.Notes,
		&unit.CreatedAt, &unit.UpdatedAt, &unit.DeletedAt, &unit.Version, &unit.LastWriter,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &unit, nil
}

// ListUnits returns the tenant's units, optionally filtered to one place.
func (s *Store) ListUnits(ctx context.Context, tenantID string, placeID *string) ([]Unit, error) {
	var units []Unit
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		query := `SELECT ` + unitColumns + ` FROM units WHERE deleted_at IS NULL`
		args := []any{}
		if placeID != nil {
			query += ` AND place_id = $1`
			args = append(args, *placeID)
		}
		query += ` ORDER BY created_at DESC`

		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			unit, err := scanUnit(rows)
			if err != nil {
				return err
			}
			units = append(units, *unit)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return units, nil
}

// GetUnit loads one unit.
func (s *Store) GetUnit(ctx context.Context, tenantID, unitID string) (*Unit, error) {
	var unit *Unit
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		var err error
		unit, err = scanUnit(tx.QueryRow(ctx,
			`SELECT `+unitColumns+` FROM units WHERE id = $1 AND deleted_at IS NULL`, unitID))
		return err
	})
	if err != nil {
		return nil, err
	}
	return unit, nil
}

// CreateUnit inserts a unit.
func (s *Store) CreateUnit(ctx context.Context, tenantID string, input *domain.UnitInput, writer string) (*Unit, error) {
	id, err := NewID()
	if err != nil {
		return nil, err
	}

	var unit *Unit
	err = s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		unit, err = scanUnit(tx.QueryRow(ctx, `
			INSERT INTO units(id, tenant_id, place_id, kind, name, location, capacity,
				base_price_minor, deposit_minor, monthly_rate_minor, currency,
				check_in_time, check_out_time, status, notes, version, last_writer)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
			RETURNING `+unitColumns,
			id, tenantID, input.PlaceID, input.Kind, input.Name, input.Location,
			input.Capacity, input.BasePriceMinor, input.DepositMinor, input.MonthlyRateMinor, input.Currency,
			input.CheckInTime, input.CheckOutTime, input.Status, input.Notes,
			version, writer))
		if err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "unit", unit.ID, "create", writer)
	})
	if err != nil {
		if constraintErr := planLimitError(err, "units", 1); constraintErr != nil {
			return nil, constraintErr
		}
		return nil, TranslateError(err)
	}
	return unit, nil
}

// UpdateUnit replaces a unit's editable fields.
func (s *Store) UpdateUnit(ctx context.Context, tenantID, unitID string, input *domain.UnitInput, writer string) (*Unit, error) {
	var unit *Unit
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		unit, err = scanUnit(tx.QueryRow(ctx, `
			UPDATE units SET
				place_id = $2, kind = $3, name = $4, location = $5, capacity = $6,
				base_price_minor = $7, deposit_minor = $8, currency = $9,
				check_in_time = $10, check_out_time = $11, status = $12, notes = $13,
				updated_at = now(), version = $14, last_writer = $15
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING `+unitColumns,
			unitID, input.PlaceID, input.Kind, input.Name, input.Location, input.Capacity,
			input.BasePriceMinor, input.DepositMinor, input.Currency,
			input.CheckInTime, input.CheckOutTime, input.Status, input.Notes,
			version, writer))
		if err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "unit", unitID, "update", writer)
	})
	if err != nil {
		if constraintErr := planLimitError(err, "units", 1); constraintErr != nil {
			return nil, constraintErr
		}
		return nil, TranslateError(err)
	}
	return unit, nil
}

// SetUnitStatus archives or restores a unit.
func (s *Store) SetUnitStatus(ctx context.Context, tenantID, unitID, status, writer string) (*Unit, error) {
	var unit *Unit
	err := s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		unit, err = scanUnit(tx.QueryRow(ctx, `
			UPDATE units SET status = $2, updated_at = now(), version = $3, last_writer = $4
			WHERE id = $1 AND deleted_at IS NULL
			RETURNING `+unitColumns, unitID, status, version, writer))
		if err != nil {
			return err
		}
		return s.audit(ctx, tx, tenantID, "unit", unitID, "status:"+status, writer)
	})
	if err != nil {
		if constraintErr := planLimitError(err, "units", 1); constraintErr != nil {
			return nil, constraintErr
		}
		return nil, TranslateError(err)
	}
	return unit, nil
}

// SoftDeleteUnit marks a unit deleted.
//
// A unit with reservations cannot be removed: the foreign key is RESTRICT, so the
// delete fails rather than orphaning bookings. The caller translates that into a
// message telling the owner to archive instead.
func (s *Store) SoftDeleteUnit(ctx context.Context, tenantID, unitID, writer string) error {
	return s.WithTenant(ctx, tenantID, func(tx pgx.Tx) error {
		version, err := s.BumpTenantVersion(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE units SET deleted_at = now(), updated_at = now(), version = $3, last_writer = $4
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, unitID, tenantID, version, writer)
		if err != nil {
			return TranslateError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return s.audit(ctx, tx, tenantID, "unit", unitID, "delete", writer)
	})
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// audit appends an audit_log row inside the caller's transaction.
//
// The audit write joins the mutation's transaction deliberately: a trail that can
// record changes that were rolled back, or miss changes that committed, is worse than
// no trail because it is trusted.
func (s *Store) audit(ctx context.Context, tx pgx.Tx, tenantID, entityType, entityID, action, writer string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_log(tenant_id, entity_type, entity_id, action, actor_id, payload_json)
		VALUES ($1, $2, $3, $4, NULL, jsonb_build_object('writer', $5::text))`,
		tenantID, entityType, entityID, action, writer)
	return err
}

// planLimitError translates the free-plan trigger's exception into the client-facing
// quota error, returning nil when the error is something else.
//
// The trigger is the authority on whether a slot was available: it runs inside the
// insert, closing the race between a count and a write that an application-level check
// cannot. This only translates its verdict into something a client can act on.
//
// The resource and limit come from the plan definition rather than the message, so a
// trigger and the error it produces cannot drift apart in wording.
func planLimitError(err error, resource string, limit int) error {
	if err == nil {
		return nil
	}
	message := err.Error()

	var marker string
	switch resource {
	case "units":
		marker = "dombook_plan_limit_units"
	case "places":
		marker = "dombook_plan_limit_places"
	default:
		return nil
	}
	if !strings.Contains(message, marker) {
		return nil
	}

	resourceLabel := "объекта размещения"
	if resource == "places" {
		resourceLabel = "дома отдыха"
	}
	return httpapi.PlanLimit(
		resource, limit, limit, string(PlanFree),
		fmt.Sprintf("Тариф «Бесплатный» позволяет создать не более %d %s.", limit, resourceLabel),
	)
}

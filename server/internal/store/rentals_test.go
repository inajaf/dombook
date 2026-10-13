package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/inajaf/dombook/server/internal/domain"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Rental availability tests.
//
// The whole rental design rests on one claim: a tenancy and a short stay are the same
// kind of row to the database, so the SINGLE exclusion constraint on `reservations`
// keeps them from overlapping. If that ever stopped being true — a `WHERE booking_kind
// = 'stay'` added to the constraint, or tenancies moved to their own table — the two
// modes would each look available while a unit was sold twice.
//
// These tests insert rows DIRECTLY rather than through the service, because that is what
// proves the guarantee is in the database rather than in whichever check happens to run
// first. A service-level test would still pass if the constraint were dropped and the
// service compensated.

// isExclusionViolation reports whether a raw driver error is the exclusion constraint.
//
// IsExclusionViolation in the store package checks the TRANSLATED error, which these tests
// do not produce: they insert directly, precisely so the guarantee is proven to live in the
// database rather than in the store's insert path.
func isExclusionViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23P01"
}

// insertion builds a minimal reservation row.
func rentalRow(id, tenantID, unitID, checkIn, checkOut, kind, status string) (string, []any) {
	return `
		INSERT INTO reservations(
			id, tenant_id, unit_id, guest_name, check_in_date, check_out_date,
			status, booking_kind, accommodation_minor
		) VALUES ($1, $2, $3, 'Тест', $4, $5, $6, $7, 0)`,
		[]any{id, tenantID, unitID, checkIn, checkOut, status, kind}
}

// insertReservation runs a raw insert inside the tenant context.
func insertReservation(t *testing.T, app *store.Store, tenantID, id, unitID, checkIn, checkOut, kind, status string) error {
	t.Helper()
	query, args := rentalRow(id, tenantID, unitID, checkIn, checkOut, kind, status)
	return app.WithTenant(context.Background(), tenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), query, args...)
		return err
	})
}

func mustID(t *testing.T) string {
	t.Helper()
	id, err := store.NewID()
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	return id
}

// TestATenancyBlocksAShortStay is the headline guarantee in one direction: a unit let for
// a year cannot also be booked for a weekend in the middle of it.
func TestATenancyBlocksAShortStay(t *testing.T) {
	app := repoStore(t)
	account, place := newTenantWithPlace(t, app, "Rental blocks stay")
	unit := newUnit(t, app, account.ID, place.ID, "Квартира", 2, 5000)

	// A one-year tenancy.
	if err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-09-01", "2027-09-01", "rental", "confirmed"); err != nil {
		t.Fatalf("the tenancy itself must be accepted: %v", err)
	}

	// A weekend in the middle of the tenancy.
	err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-10-01", "2026-10-05", "stay", "confirmed")
	if err == nil {
		t.Fatal("a short stay inside a tenancy was accepted; the unit would be sold twice")
	}
	if !isExclusionViolation(err) {
		t.Errorf("refused for the wrong reason: %v", err)
	}
}

// TestAShortStayBlocksATenancy is the same guarantee in the other direction, and it is
// not redundant: the constraint is symmetric, so a test that only checks one direction
// would pass even if the insert path special-cased rentals.
func TestAShortStayBlocksATenancy(t *testing.T) {
	app := repoStore(t)
	account, place := newTenantWithPlace(t, app, "Stay blocks rental")
	unit := newUnit(t, app, account.ID, place.ID, "Квартира", 2, 5000)

	if err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-10-01", "2026-10-05", "stay", "confirmed"); err != nil {
		t.Fatalf("the stay itself must be accepted: %v", err)
	}

	err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-09-01", "2027-09-01", "rental", "confirmed")
	if err == nil {
		t.Fatal("a tenancy overlapping an existing stay was accepted")
	}
	if !isExclusionViolation(err) {
		t.Errorf("refused for the wrong reason: %v", err)
	}
}

// TestTwoTenanciesOnOneUnitCannotOverlap is the case an owner will actually hit: two
// applicants for the same flat whose terms overlap by a week during a changeover.
func TestTwoTenanciesOnOneUnitCannotOverlap(t *testing.T) {
	app := repoStore(t)
	account, place := newTenantWithPlace(t, app, "Two tenancies")
	unit := newUnit(t, app, account.ID, place.ID, "Квартира", 2, 5000)

	if err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-01-01", "2027-01-01", "rental", "confirmed"); err != nil {
		t.Fatalf("the first tenancy must be accepted: %v", err)
	}

	err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-12-25", "2027-12-25", "rental", "confirmed")
	if err == nil {
		t.Fatal("two overlapping tenancies were accepted on one unit")
	}
	if !isExclusionViolation(err) {
		t.Errorf("refused for the wrong reason: %v", err)
	}
}

// TestBackToBackTenanciesAreAllowed is the boundary the other tests would not catch: the
// range is half-open, so one tenancy ending on the day the next begins is legal. An
// owner changing tenants on the first of the month depends on this.
func TestBackToBackTenanciesAreAllowed(t *testing.T) {
	app := repoStore(t)
	account, place := newTenantWithPlace(t, app, "Back to back")
	unit := newUnit(t, app, account.ID, place.ID, "Квартира", 2, 5000)

	if err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-01-01", "2027-01-01", "rental", "confirmed"); err != nil {
		t.Fatalf("the first tenancy must be accepted: %v", err)
	}
	if err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2027-01-01", "2028-01-01", "rental", "confirmed"); err != nil {
		t.Fatalf("a tenancy beginning the day the previous one ends must be accepted: %v", err)
	}
}

// TestADifferentUnitIsUnaffected guards against a constraint that accidentally ignores
// unit_id — which would make one flat's lease block every other property.
func TestADifferentUnitIsUnaffected(t *testing.T) {
	app := repoStore(t)
	account, place := newTenantWithPlace(t, app, "Different units")
	// Two units need a licence; the free tier's single-unit cap is unrelated to what this
	// test is about and would fail it for the wrong reason.
	grantLicense(t, app, account.ID)
	first := newUnit(t, app, account.ID, place.ID, "Квартира A", 2, 5000)
	second := newUnit(t, app, account.ID, place.ID, "Квартира B", 2, 5000)

	if err := insertReservation(t, app, account.ID, mustID(t), first.ID,
		"2026-09-01", "2027-09-01", "rental", "confirmed"); err != nil {
		t.Fatalf("the tenancy must be accepted: %v", err)
	}
	if err := insertReservation(t, app, account.ID, mustID(t), second.ID,
		"2026-10-01", "2026-10-05", "stay", "confirmed"); err != nil {
		t.Fatalf("a booking on a DIFFERENT unit must be unaffected: %v", err)
	}
}

// TestClearingTheKindStillBlocks pins the property the design depends on: the constraint
// must not be reading booking_kind. If a future change narrowed it to `booking_kind =
// 'stay'`, a tenancy would stop blocking anything and every test above would still pass
// while units were double-sold.
func TestTheConstraintDoesNotDistinguishKind(t *testing.T) {
	app := repoStore(t)
	account, place := newTenantWithPlace(t, app, "Constraint ignores kind")
	unit := newUnit(t, app, account.ID, place.ID, "Квартира", 2, 5000)

	if err := insertReservation(t, app, account.ID, mustID(t), unit.ID,
		"2026-09-01", "2027-09-01", "rental", "confirmed"); err != nil {
		t.Fatalf("the tenancy must be accepted: %v", err)
	}

	// The definition must key on unit_id and the date range only.
	var definition string
	if err := app.WithTenant(context.Background(), account.ID, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'reservations_unit_no_overlap'`,
		).Scan(&definition)
	}); err != nil {
		t.Fatalf("read the constraint definition: %v", err)
	}
	if containsFold(definition, "booking_kind") {
		t.Errorf("the exclusion constraint now filters on booking_kind, so a tenancy no longer "+
			"blocks a stay: %s", definition)
	}
}

func containsFold(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if equalFoldASCII(haystack[i:i+len(needle)], needle) {
			return true
		}
	}
	return false
}

func equalFoldASCII(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// TestRentalFieldsSurviveSync is the regression test for the failure mode this codebase
// has already hit once: a column that exists in the schema and in the service, but is
// absent from the sync allowlist, is silently dropped on push. The row still syncs, so
// nothing errors — the field just quietly stays at its default, and a tenancy arrives at
// the other device with no monthly rate and no kind.
func TestRentalFieldsSurviveSync(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, place := newTenantWithPlace(t, app, "Rental sync")
	unit := newUnit(t, app, account.ID, place.ID, "Квартира", 2, 5000)

	reservationID := mustID(t)

	// Push the fields the way a client would.
	result, err := app.Push(ctx, account.ID, "device-rental", map[store.SyncTable][]store.SyncRow{
		store.TableReservations: {{
			"id": reservationID, "unit_id": unit.ID, "guest_name": "Арендатор",
			"check_in_date": "2026-09-01", "check_out_date": "2027-09-01",
			"status":              "confirmed",
			"booking_kind":        "rental",
			"monthly_rate_minor":  int64(60000),
			"accommodation_minor": int64(720000),
			"meter_readings":      map[string]any{"electricity": map[string]any{"start": 1200, "end": 1340}},
		}},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if result.Applied != 1 {
		t.Fatalf("applied = %d, want 1 (results: %+v)", result.Applied, result.Results)
	}

	stored, err := app.GetReservation(ctx, account.ID, reservationID)
	if err != nil {
		t.Fatalf("GetReservation: %v", err)
	}

	// The kind decides which policy the row was judged by, so losing it would silently
	// turn a tenancy into a stay.
	if stored.BookingKind != string(domain.KindRental) {
		t.Errorf("booking_kind = %q, want %q", stored.BookingKind, domain.KindRental)
	}
	if stored.MonthlyRateMinor != 60000 {
		t.Errorf("monthly_rate_minor = %d, want 60000 — the rate was dropped by the allowlist",
			stored.MonthlyRateMinor)
	}
	if stored.AccommodationMinor != 720000 {
		t.Errorf("accommodation_minor = %d, want 720000", stored.AccommodationMinor)
	}
	if len(stored.MeterReadings) == 0 || string(stored.MeterReadings) == "{}" {
		t.Errorf("meter_readings = %s, want the pushed readings", stored.MeterReadings)
	}

	// And it comes back on a pull, so a second device sees the same tenancy.
	changes, _, err := app.Pull(ctx, account.ID, -1)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	var found bool
	for _, row := range changes.Reservations {
		if row["id"] != reservationID {
			continue
		}
		found = true
		if row["booking_kind"] != string(domain.KindRental) {
			t.Errorf("pulled booking_kind = %v", row["booking_kind"])
		}
		if row["monthly_rate_minor"] != int64(60000) {
			t.Errorf("pulled monthly_rate_minor = %v, want 60000", row["monthly_rate_minor"])
		}
	}
	if !found {
		t.Fatal("the pushed tenancy is missing from a full pull")
	}
}

// TestUnitMonthlyRateSurvivesSync covers the other new column, on the other table. A unit's
// monthly rate is what the Rentals screen offers, so losing it on push would make a flat
// look unavailable for rent on every other device.
func TestUnitMonthlyRateSurvivesSync(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()
	account, _ := newTenantWithPlace(t, app, "Unit rate sync")

	unitID := mustID(t)
	if _, err := app.Push(ctx, account.ID, "device-rate", map[store.SyncTable][]store.SyncRow{
		store.TableUnits: {{
			"id": unitID, "name": "Квартира с арендой", "capacity": 2,
			"base_price_minor": int64(5000), "monthly_rate_minor": int64(60000),
			"currency": "AZN", "status": "active",
		}},
	}); err != nil {
		t.Fatalf("Push: %v", err)
	}

	units, err := app.ListUnits(ctx, account.ID, nil)
	if err != nil {
		t.Fatalf("ListUnits: %v", err)
	}
	for _, unit := range units {
		if unit.ID != unitID {
			continue
		}
		if unit.MonthlyRateMinor != 60000 {
			t.Errorf("monthly_rate_minor = %d, want 60000 — dropped by the allowlist",
				unit.MonthlyRateMinor)
		}
		return
	}
	t.Fatal("the pushed unit was not stored")
}

// TestEverySyncColumnExistsInTheSchema catches the mistake at its source. Adding a column to
// the allowlist that the table does not have produces a runtime insert error on the first
// push rather than a build failure, and forgetting to add one produces the silent drop above.
// Comparing the two lists turns both into a test failure.
func TestEverySyncColumnExistsInTheSchema(t *testing.T) {
	app := repoStore(t)
	ctx := context.Background()

	tables := map[store.SyncTable]string{
		store.TablePlaces:              "places",
		store.TableUnits:               "units",
		store.TableReservations:        "reservations",
		store.TableReservationNights:   "reservation_nights",
		store.TableReservationServices: "reservation_services",
		store.TableReservationMeals:    "reservation_meals",
		store.TableAppSettings:         "app_settings",
	}

	for table, physical := range tables {
		allowed := map[string]bool{}
		for _, column := range store.SyncColumns(table) {
			allowed[column] = true
		}

		var missing []string
		err := app.WithAdmin(ctx, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = $1`, physical)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var name string
				if err := rows.Scan(&name); err != nil {
					return err
				}
				// Server-owned columns are deliberately not client-writable.
				switch name {
				case "tenant_id", "version", "updated_at", "last_writer",
					"conflict_code", "conflict_details", "resolved_at":
					continue
				}
				if !allowed[name] {
					missing = append(missing, name)
				}
			}
			return rows.Err()
		})
		if err != nil {
			t.Fatalf("read %s columns: %v", physical, err)
		}

		if len(missing) > 0 {
			t.Errorf("%s has columns absent from the sync allowlist, so a client pushing them "+
				"would have them silently dropped: %v", physical, missing)
		}
	}
}

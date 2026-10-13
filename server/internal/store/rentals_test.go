package store_test

import (
	"context"
	"errors"
	"testing"

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

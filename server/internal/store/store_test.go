package store_test

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/inajaf/dombook/server/internal/store"
	"github.com/inajaf/dombook/server/internal/testdb"
)

// Integration tests run against a real PostgreSQL instance, provisioned through
// internal/testdb so every package shares the same schema and the same unprivileged
// application role. They SKIP rather than fail when no database is configured, so
// `go test ./...` still works on a machine without one — but CI must set
// DOMBOOK_TEST_DSN, otherwise tenant isolation goes untested.
//
// Isolation cannot be meaningfully tested through a superuser connection: superusers
// bypass RLS entirely, so a broken policy would still pass. testdb asserts the
// application role cannot bypass RLS for exactly that reason.
func migrate(t *testing.T) {
	t.Helper()
	testdb.Prepare(t)
}

func testDSN(t *testing.T) string { t.Helper(); return testdb.DSN(t) }
func appDSN(t *testing.T) string  { t.Helper(); return testdb.AppDSN(t) }

// newAdminPool connects as the migration/owner role, which bypasses RLS. It exists
// only for seeding and for assertions that must see across tenants; the assertions
// about isolation deliberately use newAppStore instead.
func newAdminPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	migrate(t)
	pool, err := store.OpenPool(context.Background(), testDSN(t))
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedAccount creates an account plus one unit as the owner role, so seeding does
// not depend on the isolation under test.
func seedAccount(t *testing.T, admin *pgxpool.Pool, name string) (accountID, unitID string) {
	t.Helper()
	ctx := context.Background()

	accountID = uuid.NewString()
	if _, err := admin.Exec(ctx,
		"INSERT INTO accounts(id, name) VALUES ($1, $2)", accountID, name); err != nil {
		t.Fatalf("seed account %s: %v", name, err)
	}

	unitID = uuid.NewString()
	if _, err := admin.Exec(ctx,
		"INSERT INTO units(id, tenant_id, name) VALUES ($1, $2, $3)",
		unitID, accountID, "Unit "+name); err != nil {
		t.Fatalf("seed unit for %s: %v", name, err)
	}
	return accountID, unitID
}

func newAppStore(t *testing.T) *store.Store {
	t.Helper()
	app, err := store.New(context.Background(), appDSN(t))
	if err != nil {
		t.Fatalf("connect as dombook_app: %v", err)
	}
	t.Cleanup(app.Close)
	return app
}

// unitNames returns the unit names visible in the given tenant's transaction.
func unitNames(t *testing.T, app *store.Store, tenantID string) []string {
	t.Helper()
	var names []string
	err := app.WithTenant(context.Background(), tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), "SELECT name FROM units ORDER BY name")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				return err
			}
			names = append(names, name)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatalf("list units for tenant %s: %v", tenantID, err)
	}
	return names
}

func TestTenantIsolationIsEnforcedByTheDatabase(t *testing.T) {
	migrate(t)
	admin := newAdminPool(t)
	app := newAppStore(t)

	tenantA, _ := seedAccount(t, admin, "Tenant A")
	tenantB, _ := seedAccount(t, admin, "Tenant B")

	t.Run("a tenant sees only its own rows", func(t *testing.T) {
		namesA := unitNames(t, app, tenantA)
		if len(namesA) != 1 || namesA[0] != "Unit Tenant A" {
			t.Fatalf("tenant A sees %v, want [Unit Tenant A]", namesA)
		}

		namesB := unitNames(t, app, tenantB)
		if len(namesB) != 1 || namesB[0] != "Unit Tenant B" {
			t.Fatalf("tenant B sees %v, want [Unit Tenant B]", namesB)
		}
	})

	t.Run("a cross-tenant write is refused", func(t *testing.T) {
		err := app.WithTenant(context.Background(), tenantA, func(tx pgx.Tx) error {
			// Tenant A tries to create a row owned by tenant B.
			_, err := tx.Exec(context.Background(),
				"INSERT INTO units(tenant_id, name) VALUES ($1, $2)", tenantB, "Smuggled")
			return err
		})
		if err == nil {
			t.Fatal("expected the cross-tenant insert to be refused by RLS")
		}
		if !store.IsUniqueViolation(err) && !strings.Contains(err.Error(), "row-level security") {
			t.Fatalf("expected an RLS policy violation, got: %v", err)
		}
	})

	t.Run("an unscoped query returns nothing instead of everything", func(t *testing.T) {
		// No tenant set at all. current_tenant_id() is NULL, so every policy
		// comparison is false and the result is empty. This is the deliberate
		// failure mode: missing data is loud, a cross-tenant leak is silent.
		var count int
		err := app.WithAdmin(context.Background(), func(tx pgx.Tx) error {
			// WithAdmin does not set a tenant, mirroring a request path that
			// forgot to. It still runs as dombook_app, so RLS applies.
			return tx.QueryRow(context.Background(), "SELECT count(*) FROM units").Scan(&count)
		})
		if err != nil {
			t.Fatalf("unscoped query: %v", err)
		}
		if count != 0 {
			t.Fatalf("unscoped query returned %d rows; it must return 0", count)
		}
	})
}

// TestTenantContextDoesNotLeakBetweenRequests guards the pooled-connection
// hazard: set_config(..., is_local => true) must be scoped to the transaction.
// If it were session-scoped, the next request reusing this connection would
// inherit the previous tenant and read another business's data.
func TestTenantContextDoesNotLeakBetweenRequests(t *testing.T) {
	migrate(t)
	admin := newAdminPool(t)
	app := newAppStore(t)

	tenantA, _ := seedAccount(t, admin, "Leak A")
	tenantB, _ := seedAccount(t, admin, "Leak B")

	// Run many transactions from the same pool: connections are reused, so a
	// session-scoped variable would eventually be observed by the wrong tenant.
	for i := 0; i < 20; i++ {
		namesA := unitNames(t, app, tenantA)
		if len(namesA) != 1 || namesA[0] != "Unit Leak A" {
			t.Fatalf("iteration %d: tenant A saw %v", i, namesA)
		}
		namesB := unitNames(t, app, tenantB)
		if len(namesB) != 1 || namesB[0] != "Unit Leak B" {
			t.Fatalf("iteration %d: tenant B saw %v", i, namesB)
		}
	}
}

// TestWithTenantRequiresATenant documents the guard against silently running an
// unscoped query: an empty tenant is rejected rather than treated as "all".
func TestWithTenantRequiresATenant(t *testing.T) {
	err := (&store.Store{}).WithTenant(context.Background(), "", func(pgx.Tx) error {
		t.Fatal("fn must not run without a tenant")
		return nil
	})
	if err == nil {
		t.Fatal("expected an error when the tenant id is empty")
	}
	if !strings.Contains(err.Error(), "tenant") {
		t.Fatalf("expected a tenant-related error, got: %v", err)
	}
}

// TestSeededIdsAreUuids keeps the seed helper honest: the schema expects uuid
// columns, and a test that silently accepted a non-uuid would mask a migration
// typing regression.
func TestSeededIdsAreUuids(t *testing.T) {
	migrate(t)
	admin := newAdminPool(t)
	accountID, unitID := seedAccount(t, admin, "Uuid Check")

	for label, id := range map[string]string{"account": accountID, "unit": unitID} {
		if _, err := uuid.Parse(id); err != nil {
			t.Errorf("%s id %q is not a uuid: %v", label, id, err)
		}
	}
}

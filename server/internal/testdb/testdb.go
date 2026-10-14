// Package testdb provisions a PostgreSQL database for integration tests.
//
// It exists so that every package testing against a real database gets the same
// guarantees: the same migrations, the same unprivileged application role, and the
// same skip-instead-of-fail behavior when no database is configured. Duplicating
// that setup per package is how one of them quietly drifts into connecting as a
// superuser, at which point its tenant-isolation assertions stop testing anything.
package testdb

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/inajaf/dombook/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DSN returns the base (owner) connection string, skipping the test when unset.
func DSN(t *testing.T) string {
	t.Helper()
	// RENTKEEPER_TEST_DSN is the current name, DOMBOOK_TEST_DSN the one an existing CI job or
	// developer shell still exports. Both are honoured: silently skipping because the name
	// changed would leave tenant isolation untested while the suite reported success.
	dsn := os.Getenv("RENTKEEPER_TEST_DSN")
	if dsn == "" {
		dsn = os.Getenv("DOMBOOK_TEST_DSN")
	}
	if dsn == "" {
		t.Skip("RENTKEEPER_TEST_DSN is not set; skipping PostgreSQL integration tests")
	}
	return dsn
}

// The two roles the suite connects as, and the passwords it gives them.
//
// Named constants rather than string literals at each use site: the isolation tests are only
// meaningful if the DSN really authenticates as the UNPRIVILEGED role, so the name appears in
// the DSN rewrite, the ALTER ROLE that provisions it, and the assertion that it cannot bypass
// RLS. Three copies of a literal is how one of them drifts and the suite starts testing as a
// role that sees everything.
const (
	appRoleName       = "rentkeeper_app"
	appRolePassword   = "app"
	adminRoleName     = "rentkeeper_admin"
	adminRolePassword = "adminpw"
)

// AdminDSN rewrites the base DSN to authenticate as the operator role, which BYPASSES RLS.
//
// Needed by tests of cross-tenant queries. Using the application role for those would make
// every result empty, which looks like a broken query rather than a missing privilege.
func AdminDSN(t *testing.T) string {
	t.Helper()
	dsn := DSN(t)
	at := strings.Index(dsn, "@")
	scheme := strings.Index(dsn, "://")
	if at < 0 || scheme < 0 {
		t.Fatalf("RENTKEEPER_TEST_DSN is not in a recognized form: %q", dsn)
	}
	return dsn[:scheme+3] + adminRoleName + ":" + adminRolePassword + dsn[at:]
}

// AppDSN rewrites the base DSN to authenticate as the unprivileged application
// role, which is what makes RLS apply.
func AppDSN(t *testing.T) string {
	t.Helper()
	dsn := DSN(t)
	at := strings.Index(dsn, "@")
	scheme := strings.Index(dsn, "://")
	if at < 0 || scheme < 0 {
		t.Fatalf("RENTKEEPER_TEST_DSN is not in a recognized form: %q", dsn)
	}
	return dsn[:scheme+3] + appRoleName + ":" + appRolePassword + dsn[at:]
}

// SkipMigrate reports whether the caller asked to leave the schema untouched.
//
// This is the probe hook: mutating the schema (switching RLS off, dropping a
// constraint) and then re-running a test is how we confirm the test actually
// detects the regression, instead of the migrations being reapplied underneath the
// probe and hiding it.
func SkipMigrate() bool { return os.Getenv("DOMBOOK_SKIP_MIGRATE") != "" }

var (
	migrateOnce sync.Once
	migrateErr  error
)

// Prepare brings the database to a known schema: it reverts everything, applies all
// migrations, and ensures the application role can authenticate.
//
// Resetting rather than only applying forward matters because a shared test database
// accumulates state between runs, and a stale object (an old function overload, a
// policy that no longer exists in the migrations) would make the suite pass against
// a schema no fresh deployment would ever have.
//
// Two levels of coordination are needed, because `go test ./...` runs packages in
// PARALLEL processes:
//
//   - sync.Once dedupes the work inside one binary;
//   - a PostgreSQL advisory lock serializes it ACROSS binaries. Without the lock,
//     two packages concurrently running ResetTo + Migrate drop and recreate each
//     other's tables mid-test, which surfaces as unrelated failures like "relation
//     does not exist" in whichever package happened to be running.
//
// The lock is released when the transaction ends, including if the process dies, so
// a crashed test run cannot wedge the next one.
func Prepare(t *testing.T) {
	t.Helper()
	dsn := DSN(t)
	migrateOnce.Do(func() { migrateErr = claimAndPrepare(context.Background(), dsn) })
	if migrateErr != nil {
		t.Fatalf("prepare test database: %v", migrateErr)
	}
	// Role setup is idempotent and repeated per binary so that a binary which
	// skipped migration still gets it right. It takes the same advisory lock because
	// ALTER ROLE acquires a lock on the shared pg_authid catalog, and two binaries
	// issuing it simultaneously can deadlock against each other's transactions.
	if err := withAdvisoryLock(context.Background(), dsn, func(ctx context.Context) error {
		return ensureAppRole(ctx, dsn)
	}); err != nil {
		t.Fatalf("ensure application role: %v", err)
	}
}

// testDBLockKey is an arbitrary but fixed advisory-lock key identifying "the
// RentKeeper test schema". Any constant works as long as every test package uses the
// same one.
const testDBLockKey int64 = 0x646F6D626F6F6B // "dombook": the hex is historic and MUST NOT change

// claimAndPrepare records which test binary owns the database, then provisions it.
//
// Integration tests share ONE database, and `go test ./...` runs packages as
// PARALLEL processes. Two of them cannot both own the same schema: one truncates
// tables while the other is asserting on them, which surfaces as random failures
// ("setup_denied" because another package's user is still present, or "function does
// not exist" mid-rebuild) that pass on a rerun.
//
// Rather than paper over that with retries, the ownership is recorded and a second
// binary is refused with instructions. A loud, actionable failure at startup is worth
// far more than an intermittent one buried in an unrelated assertion.
func claimAndPrepare(ctx context.Context, dsn string) error {
	pool, err := store.OpenPool(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect to claim test database: %w", err)
	}
	defer pool.Close()

	const createOwners = `
		CREATE TABLE IF NOT EXISTS test_binary_owner (
			id      int PRIMARY KEY DEFAULT 1,
			pid     int NOT NULL,
			claimed timestamptz NOT NULL DEFAULT now(),
			CONSTRAINT test_binary_owner_single CHECK (id = 1)
		)`
	if _, err := pool.Exec(ctx, createOwners); err != nil {
		return fmt.Errorf("create ownership marker: %w", err)
	}

	// A re-run of the same binary reuses its own row; a different live process is
	// rejected.
	var ownerPID int
	var ownerAge time.Duration
	err = pool.QueryRow(ctx,
		"SELECT pid, now() - claimed FROM test_binary_owner WHERE id = 1").Scan(&ownerPID, &ownerAge)
	switch {
	case err == nil:
		if ownerPID != os.Getpid() && processAlive(ownerPID) && ownerAge < 30*time.Minute {
			return fmt.Errorf(
				"the test database is already owned by another live test binary (pid %d, claimed %s ago).\n"+
					"Integration tests share one database, so packages must not run in parallel.\n"+
					"Run them serially:\n\n    go test -p 1 ./...\n",
				ownerPID, ownerAge.Round(time.Second))
		}
		if _, err := pool.Exec(ctx,
			"UPDATE test_binary_owner SET pid = $1, claimed = now() WHERE id = 1", os.Getpid()); err != nil {
			return fmt.Errorf("take ownership: %w", err)
		}
	default:
		if _, err := pool.Exec(ctx,
			"INSERT INTO test_binary_owner(id, pid) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET pid = $1, claimed = now()",
			os.Getpid()); err != nil {
			return fmt.Errorf("claim test database: %w", err)
		}
	}

	return prepareSerialized(ctx, dsn)
}

// processAlive reports whether a pid belongs to a running process. A stale marker
// from a crashed run must not block the next one forever.
func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// On Unix FindProcess always succeeds, so liveness is probed with signal 0.
	return process.Signal(syscall.Signal(0)) == nil
}

func prepareSerialized(ctx context.Context, dsn string) error {
	pool, err := store.OpenPool(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect for migrations: %w", err)
	}
	defer pool.Close()

	// A session-level lock held on a dedicated connection, so it stays held across
	// the ResetTo and Migrate calls below.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()

	return withAdvisoryConn(ctx, conn, func(ctx context.Context) error {
		return prepare(ctx, dsn)
	})
}

// withAdvisoryLock runs fn while holding the test-schema advisory lock.
func withAdvisoryLock(ctx context.Context, dsn string, fn func(context.Context) error) error {
	pool, err := store.OpenPool(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	return withAdvisoryConn(ctx, conn, fn)
}

// withAdvisoryConn holds the lock on one connection for the duration of fn.
//
// A session-level advisory lock is used rather than a transaction-level one because
// the work inside spans several statements that must not be wrapped together
// (CREATE EXTENSION and ADD CONSTRAINT ... EXCLUDE cannot run in a transaction
// block). The lock is released explicitly and also implicitly when the connection
// closes, so a crashed run cannot wedge the next one.
func withAdvisoryConn(ctx context.Context, conn *pgxpool.Conn, fn func(context.Context) error) error {
	// Bound the wait: a hung lock should fail the suite with a clear message rather
	// than stall CI until its global timeout.
	if _, err := conn.Exec(ctx, "SET lock_timeout = '180s'"); err != nil {
		return fmt.Errorf("set lock timeout: %w", err)
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", testDBLockKey); err != nil {
		return fmt.Errorf("acquire advisory lock: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", testDBLockKey)
	}()
	return fn(ctx)
}

func prepare(ctx context.Context, dsn string) error {
	if SkipMigrate() {
		return nil
	}
	// One transaction, not ResetTo followed by Migrate: the two-call form lets a
	// concurrent package observe the schema between the drop and the recreate, which
	// produced intermittent "function does not exist" failures that passed on rerun.
	if err := store.ResetAndMigrate(ctx, dsn); err != nil {
		return fmt.Errorf("rebuild schema: %w", err)
	}
	return nil
}

// ResetData empties every table, leaving the schema in place.
//
// Tests that exercise bootstrap need this: POST /auth/setup is open only while the
// installation has zero users, so one earlier test would close signup for every test
// after it.
//
// The table list is DISCOVERED rather than hard-coded. A hand-maintained list is
// silently incomplete the moment a migration adds a table — the reset then leaves
// rows behind, and the resulting failures appear in unrelated tests, as a stale
// bootstrap gate or a duplicate email, rather than as "the reset missed a table".
func ResetData(t *testing.T) {
	t.Helper()
	pool, err := store.OpenPool(context.Background(), DSN(t))
	if err != nil {
		t.Fatalf("connect to reset data: %v", err)
	}
	defer pool.Close()

	ctx := context.Background()

	// Held for the same reason migrations hold it: a reset landing while another
	// package rebuilds the schema would truncate tables that are about to be dropped
	// and recreated, leaving that package with an empty database mid-test.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire reset connection: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SET lock_timeout = '120s'"); err != nil {
		t.Fatalf("set lock timeout: %v", err)
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", testDBLockKey); err != nil {
		t.Fatalf("acquire reset lock: %v", err)
	}
	defer func() {
		_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", testDBLockKey)
	}()
	rows, err := pool.Query(ctx, `
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> 'goose_db_version'
		ORDER BY tablename`)
	if err != nil {
		t.Fatalf("list tables to reset: %v", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatalf("scan table name: %v", err)
		}
		tables = append(tables, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate tables: %v", err)
	}
	if len(tables) == 0 {
		t.Fatal("no tables found to reset; did the migrations run?")
	}

	// A single TRUNCATE ... CASCADE is atomic and order-independent, so foreign keys
	// cannot be violated and a partial reset cannot happen. CASCADE reaches tables
	// that reference the listed ones, which is why the explicit child ordering the
	// previous DELETE approach needed is unnecessary here.
	quoted := make([]string, len(tables))
	for i, name := range tables {
		quoted[i] = pgx.Identifier{name}.Sanitize()
	}
	statement := "TRUNCATE TABLE " + strings.Join(quoted, ", ") + " RESTART IDENTITY CASCADE"
	// Run on the locked connection so the lock actually covers this statement.
	if _, err := conn.Exec(ctx, statement); err != nil {
		t.Fatalf("reset tables: %v", err)
	}
}

func ensureAppRole(ctx context.Context, dsn string) error {
	pool, err := store.OpenPool(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Both roles need passwords matching their DSNs. Production provisions these; locally
	// this makes `go test` work out of the box. The admin role matters because cross-tenant
	// tests (the conflict queue) must connect as a role that BYPASSES RLS — running them as
	// the application role would silently see nothing and look like a bug in the query.
	if _, err := pool.Exec(ctx, "ALTER ROLE "+appRoleName+" WITH PASSWORD '"+appRolePassword+"'"); err != nil {
		return fmt.Errorf("set %s password: %w", appRoleName, err)
	}
	if _, err := pool.Exec(ctx, "ALTER ROLE "+adminRoleName+" WITH PASSWORD '"+adminRolePassword+"'"); err != nil {
		return fmt.Errorf("set %s password: %w", adminRoleName, err)
	}

	// Assert the precondition the isolation tests rest on. If the application role ever
	// gained BYPASSRLS, every assertion about tenant isolation would silently stop
	// testing anything — the queries would simply return other tenants' rows.
	var bypasses bool
	if err := pool.QueryRow(ctx,
		"SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = $1", appRoleName).Scan(&bypasses); err != nil {
		return fmt.Errorf("inspect %s: %w", appRoleName, err)
	}
	if bypasses {
		return fmt.Errorf("%s must not be SUPERUSER or BYPASSRLS: isolation tests would be vacuous", appRoleName)
	}
	return nil
}

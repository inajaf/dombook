package d1import_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/inajaf/dombook/server/internal/d1import"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/inajaf/dombook/server/internal/testdb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "modernc.org/sqlite"
)

// Import tests.
//
// These run against a real PostgreSQL database and a real SQLite file, because the whole
// point of the tool is that two different engines agree about types, identities, and column
// names. A test with a mock destination would prove none of that.

// poolAdapter exposes the pool as the narrow interface the importer takes.
type poolAdapter struct {
	dsn string
}

func (p poolAdapter) WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error {
	conn, err := pgx.Connect(ctx, p.dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// sourceSchema is the D1 table set, with the columns the import cares about.
//
// Mirrors the legacy D1 migrations (now removed; see the archive noted in CUTOVER.md) so the
// test exercises the real shapes: a `properties` table whose
// rows become `units`, and foreign keys named `property_id` that become `unit_id`.
var sourceSchema = map[string]string{
	"accounts":             "id TEXT PRIMARY KEY, name TEXT, plan TEXT, created_at TEXT, updated_at TEXT",
	"users":                "id TEXT PRIMARY KEY, account_id TEXT, email TEXT, name TEXT, role TEXT, created_at TEXT, updated_at TEXT",
	"places":               "id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, address TEXT, has_food_service INTEGER, breakfast_price_minor INTEGER, lunch_price_minor INTEGER, dinner_price_minor INTEGER, status TEXT, notes TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"properties":           "id TEXT PRIMARY KEY, tenant_id TEXT, place_id TEXT, kind TEXT, name TEXT, location TEXT, capacity INTEGER, base_price_minor INTEGER, deposit_minor INTEGER, currency TEXT, check_in_time TEXT, check_out_time TEXT, status TEXT, notes TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"reservations":         "id TEXT PRIMARY KEY, tenant_id TEXT, property_id TEXT, guest_name TEXT, guest_phone TEXT, guest_email TEXT, check_in_date TEXT, check_out_date TEXT, adults INTEGER, children INTEGER, status TEXT, nightly_rate_minor INTEGER, accommodation_minor INTEGER, services_minor INTEGER, total_minor INTEGER, prepaid_minor INTEGER, deposit_minor INTEGER, deposit_status TEXT, actual_check_out_date TEXT, notes TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"reservation_nights":   "id TEXT PRIMARY KEY, tenant_id TEXT, reservation_id TEXT, property_id TEXT, night_date TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"reservation_services": "id TEXT PRIMARY KEY, tenant_id TEXT, reservation_id TEXT, service_type TEXT, service_name TEXT, unit_price_minor INTEGER, quantity INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"reservation_meals":    "id TEXT PRIMARY KEY, tenant_id TEXT, reservation_id TEXT, meal_date TEXT, meal_type TEXT, amount_minor INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"app_settings":         "id TEXT PRIMARY KEY, tenant_id TEXT, setting_key TEXT, setting_value TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER, last_writer TEXT",
	"tenant_state":         "tenant_id TEXT PRIMARY KEY, version INTEGER, updated_at TEXT",
	"audit_log":            "id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, entity_id TEXT, action TEXT, payload_json TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER",
	"sessions":             "id TEXT PRIMARY KEY, user_id TEXT, token TEXT, created_at TEXT",
	"verification_codes":   "id TEXT PRIMARY KEY, email TEXT, code TEXT, created_at TEXT",
}

const (
	accountID = "aaaaaaaa-0000-4000-8000-000000000001"
	userID    = "bbbbbbbb-0000-4000-8000-000000000001"
	placeID   = "cccccccc-0000-4000-8000-000000000001"
	unitID    = "dddddddd-0000-4000-8000-000000000001"
	resID     = "eeeeeeee-0000-4000-8000-000000000001"
	timestamp = "2026-03-01T10:00:00.000Z"
)

// buildSource writes a D1-shaped SQLite file with one account and its data.
func buildSource(t *testing.T) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "d1.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	for name, columns := range sourceSchema {
		if _, err := db.Exec("CREATE TABLE " + name + " (" + columns + ")"); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
	}

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatalf("seed (%s): %v", query, err)
		}
	}

	exec(`INSERT INTO accounts VALUES (?,?,?,?,?)`, accountID, "Лесная долина", "free", timestamp, timestamp)
	exec(`INSERT INTO users VALUES (?,?,?,?,?,?,?)`, userID, accountID, "owner@example.test", "Owner", "owner", timestamp, timestamp)
	exec(`INSERT INTO places VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		placeID, accountID, "Лесная долина", "Габала", 1, 1500, 2500, 2000, "active", "", timestamp, timestamp, nil, 3, "device-a")
	exec(`INSERT INTO properties VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		unitID, accountID, placeID, "cottage", "Коттедж «Сосны»", "Верхняя терраса", 4, 24000, 30000, "AZN",
		"15:00", "11:00", "active", "", timestamp, timestamp, nil, 5, "device-a")
	exec(`INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		resID, accountID, unitID, "Иван Петров", "+994500000000", "", "2026-04-01", "2026-04-04", 2, 1,
		"confirmed", 24000, 72000, 0, 72000, 20000, 30000, "received", nil, "", timestamp, timestamp, nil, 4, "device-b")
	for index, day := range []string{"2026-04-01", "2026-04-02", "2026-04-03"} {
		exec(`INSERT INTO reservation_nights VALUES (?,?,?,?,?,?,?,?,?,?)`,
			"ffffffff-0000-4000-8000-00000000000"+string(rune('1'+index)), accountID, resID, unitID, day, timestamp, timestamp, nil, 1, "device-b")
	}
	exec(`INSERT INTO reservation_services VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		"99999999-0000-4000-8000-000000000001", accountID, resID, "dinner", "Ужин на террасе", 8000, 1, timestamp, timestamp, nil, 1, "device-b")
	exec(`INSERT INTO reservation_meals VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		"88888888-0000-4000-8000-000000000001", accountID, resID, "2026-04-02", "breakfast", 1500, timestamp, timestamp, nil, 1, "device-b")
	exec(`INSERT INTO app_settings VALUES (?,?,?,?,?,?,?,?,?)`,
		"77777777-0000-4000-8000-000000000001", accountID, "interface_language", "ru", timestamp, timestamp, nil, 1, "device-a")
	exec(`INSERT INTO tenant_state VALUES (?,?,?)`, accountID, 42, timestamp)
	exec(`INSERT INTO audit_log VALUES (?,?,?,?,?,?,?,?,?,?)`,
		"66666666-0000-4000-8000-000000000001", accountID, "reservation", resID, "created", `{"guest":"Иван"}`, timestamp, timestamp, nil, 1)
	// Credential material, which must NOT be migrated.
	exec(`INSERT INTO sessions VALUES (?,?,?,?)`, "55555555-0000-4000-8000-000000000001", userID, "old-token", timestamp)
	exec(`INSERT INTO verification_codes VALUES (?,?,?,?)`, "44444444-0000-4000-8000-000000000001", "owner@example.test", "123456", timestamp)

	return path
}

// importInto runs the importer against the test database.
func importInto(t *testing.T, options d1import.Options) (*d1import.Result, error) {
	t.Helper()
	testdb.Prepare(t)
	testdb.ResetData(t)

	source, err := d1import.OpenSource(buildSource(t))
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	t.Cleanup(func() { source.Close() })

	if options.SQLitePath == "" {
		options.SQLitePath = "provided by the caller"
	}
	return d1import.Run(context.Background(), source, poolAdapter{dsn: testdb.DSN(t)}, options)
}

func TestImportMovesEveryDomainTable(t *testing.T) {
	result, err := importInto(t, d1import.Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	want := map[string]int{
		"accounts": 1, "users": 1, "places": 1, "units": 1,
		"reservations": 1, "reservation_nights": 3,
		"reservation_services": 1, "reservation_meals": 1,
		"app_settings": 1, "tenant_state": 1, "audit_log": 1,
	}
	for table, expected := range want {
		if result.Counts[table] != expected {
			t.Errorf("%s: imported %d rows, want %d", table, result.Counts[table], expected)
		}
	}
}

// TestImportDoesNotMigrateCredentials is the security-relevant decision: sessions and
// one-time codes belong to the old deployment, and carrying them over would keep credentials
// alive across the cutover that nobody is tracking any more.
func TestImportDoesNotMigrateCredentials(t *testing.T) {
	result, err := importInto(t, d1import.Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	for _, table := range []string{"sessions", "verification_codes"} {
		if _, skipped := result.Skipped[table]; !skipped {
			t.Errorf("%s was not reported as skipped", table)
		}
		if result.Counts[table] != 0 {
			t.Errorf("%s was imported, which would carry old credentials forward", table)
		}
	}

	// The destination has its own tables for both, because the new server issues its own
	// sessions and its own one-time codes. What matters is that the SOURCE's rows were not
	// copied into them: carrying a session across the cutover would keep a credential alive
	// that nobody is tracking, and carrying a one-time code would do the same for a login.
	pool := mustPool(t)
	ctx := context.Background()

	for _, table := range []string{"sessions", "verification_codes"} {
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM `+table).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count != 0 {
			t.Errorf("the source's %s rows were copied into the destination: %d rows", table, count)
		}
	}

	// And the source really did have rows to copy, so the check above is not vacuous.
	sourceRows, err := sourceCount(buildSource(t), "sessions")
	if err != nil {
		t.Fatalf("count source sessions: %v", err)
	}
	if sourceRows == 0 {
		t.Fatal("the source fixture has no sessions, so this test proves nothing")
	}
}

// sourceCount counts rows in the fixture, so a test can assert it had data to migrate.
func sourceCount(path, table string) (int, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return 0, err
	}
	defer db.Close()

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// TestImportPreservesIdentity is the property the whole cutover depends on. Regenerating ids
// would make every desktop client re-create its data as new rows, duplicating everything.
func TestImportPreservesIdentity(t *testing.T) {
	if _, err := importInto(t, d1import.Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	pool := mustPool(t)
	ctx := context.Background()

	var id, name string
	var version int64
	if err := pool.QueryRow(ctx, `SELECT id, name, version FROM units`).Scan(&id, &name, &version); err != nil {
		t.Fatalf("read unit: %v", err)
	}
	if id != unitID {
		t.Errorf("unit id = %s, want the original %s", id, unitID)
	}
	if name != "Коттедж «Сосны»" {
		t.Errorf("unit name = %q", name)
	}
	// The version carries over so a client's cursor still means something.
	if version != 5 {
		t.Errorf("unit version = %d, want 5", version)
	}

	var resVersion int64
	if err := pool.QueryRow(ctx, `SELECT version FROM reservations`).Scan(&resVersion); err != nil {
		t.Fatalf("read reservation: %v", err)
	}
	if resVersion != 4 {
		t.Errorf("reservation version = %d, want 4", resVersion)
	}
}

// TestImportRenamesTheUnitColumns covers the schema difference: D1 calls it `properties` and
// `property_id`, the server calls it `units` and `unit_id`. Getting this wrong would leave
// bookings pointing at nothing.
func TestImportRenamesTheUnitColumns(t *testing.T) {
	if _, err := importInto(t, d1import.Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	pool := mustPool(t)

	var linked int
	if err := pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM reservations r JOIN units u ON u.id = r.unit_id`).Scan(&linked); err != nil {
		t.Fatalf("join: %v", err)
	}
	if linked != 1 {
		t.Errorf("joined %d reservations to their unit, want 1", linked)
	}
}

// TestImportPreservesTheServiceName is the regression test for the field the baseline schema
// dropped. Without the column the copy has nowhere to go, and the text the guest sees on the
// invoice disappears silently.
func TestImportPreservesTheServiceName(t *testing.T) {
	if _, err := importInto(t, d1import.Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	pool := mustPool(t)

	var serviceType, serviceName string
	if err := pool.QueryRow(context.Background(),
		`SELECT service_type, service_name FROM reservation_services`).Scan(&serviceType, &serviceName); err != nil {
		t.Fatalf("read service: %v", err)
	}
	if serviceName != "Ужин на террасе" {
		t.Errorf("service_name = %q, want the original label", serviceName)
	}
	if serviceType != "dinner" {
		t.Errorf("service_type = %q, want dinner", serviceType)
	}
}

// TestImportConvertsBooleans: SQLite has no boolean type, so the column arrives as 0/1 and
// PostgreSQL rejects the integer. Without the conversion a place row fails to import.
func TestImportConvertsBooleans(t *testing.T) {
	if _, err := importInto(t, d1import.Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	pool := mustPool(t)

	var hasFood bool
	var typeName string
	if err := pool.QueryRow(context.Background(),
		`SELECT has_food_service, pg_typeof(has_food_service)::text FROM places`).Scan(&hasFood, &typeName); err != nil {
		t.Fatalf("read place: %v", err)
	}
	if !hasFood {
		t.Error("has_food_service = false, but the source stored 1")
	}
	if typeName != "boolean" {
		t.Errorf("column type = %s, want boolean", typeName)
	}
}

// TestImportRefusesANonEmptyTarget is the guard against the likeliest operator mistake.
// Importing on top of existing rows would duplicate them with no way to tell which came from
// where.
func TestImportRefusesANonEmptyTarget(t *testing.T) {
	if _, err := importInto(t, d1import.Options{}); err != nil {
		t.Fatalf("first import: %v", err)
	}

	source, err := d1import.OpenSource(buildSource(t))
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	defer source.Close()

	_, err = d1import.Run(context.Background(), source, poolAdapter{dsn: testdb.DSN(t)}, d1import.Options{})
	if !errors.Is(err, d1import.ErrTargetNotEmpty) {
		t.Fatalf("second import error = %v, want ErrTargetNotEmpty", err)
	}
}

// TestDryRunWritesNothing: a rehearsal has to be free, or nobody will rehearse.
func TestDryRunWritesNothing(t *testing.T) {
	result, err := importInto(t, d1import.Options{DryRun: true})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Counts["units"] != 1 {
		t.Errorf("the dry run reported %d units, want 1", result.Counts["units"])
	}

	pool := mustPool(t)

	var units int
	if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM units`).Scan(&units); err != nil {
		t.Fatalf("count units: %v", err)
	}
	if units != 0 {
		t.Errorf("the dry run wrote %d units", units)
	}
}

// TestAFailedImportLeavesNothingBehind: a migration that half-applies is worse than one that
// fails, because the operator cannot tell what arrived.
func TestAFailedImportLeavesNothingBehind(t *testing.T) {
	testdb.Prepare(t)
	testdb.ResetData(t)

	// A source whose reservation has no matching unit, which the foreign key will refuse.
	path := buildSource(t)
	source, err := d1import.OpenSource(path)
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	defer source.Close()

	writer, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open for repair: %v", err)
	}
	// Point the booking at a unit that does not exist.
	if _, err := writer.Exec(`UPDATE reservations SET property_id = '11111111-1111-1111-1111-111111111111'`); err != nil {
		t.Fatalf("break the reference: %v", err)
	}
	writer.Close()

	if _, err := d1import.Run(context.Background(), source, poolAdapter{dsn: testdb.DSN(t)}, d1import.Options{}); err == nil {
		t.Fatal("an import with a dangling reference should fail")
	}

	// Nothing committed, so a corrected retry is possible.
	pool := mustPool(t)

	for _, table := range []string{"accounts", "users", "places", "units", "reservations"} {
		var count int
		if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM `+table).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count != 0 {
			t.Errorf("a failed import left %d rows in %s", count, table)
		}
	}
}

// TestPartialImportRequiresItsDependencies: importing reservations without units would leave
// every booking pointing at a row that is not there.
func TestPartialImportRequiresItsDependencies(t *testing.T) {
	testdb.Prepare(t)
	testdb.ResetData(t)

	source, err := d1import.OpenSource(buildSource(t))
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	defer source.Close()

	_, err = d1import.Run(context.Background(), source, poolAdapter{dsn: testdb.DSN(t)},
		d1import.Options{Tables: []string{"reservations"}})
	if err == nil {
		t.Fatal("importing reservations without units should be refused")
	}
}

// mustPool opens a raw pool for assertions. The owner DSN is used deliberately: the checks
// count rows across tenants, which RLS would hide from the application role.
func mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := store.OpenPool(context.Background(), testdb.DSN(t))
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

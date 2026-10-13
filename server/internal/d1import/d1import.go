// Package d1import copies an existing Cloudflare D1 database into PostgreSQL.
//
// This is the cutover path. The product ran against D1 in production, so the migration has to
// move real tenant data — not a fixture — without losing or duplicating anything.
//
// The tool is written against the two schemas rather than against a JSON export, because
// going through an intermediate format would mean two lossy conversions instead of one. It
// reads the D1 SQLite file directly and writes rows into PostgreSQL.
//
// Two decisions shape everything here:
//
//   - Identity is preserved. Every id is copied verbatim. Regenerating ids would break every
//     desktop client that holds the old ones, and each client would then re-create its data
//     as new rows — the duplicate-everything failure. The one exception is accounts, whose id
//     has to exist before its children, and even there the original id is kept.
//
//   - The target must be empty. Running a migration twice is the most likely operator
//     mistake, and merging into a populated database would half-apply without any way to tell
//     which rows came from where. Re-running after a failure is safe because the failed
//     attempt leaves nothing behind: the whole import is one transaction.
package d1import

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	_ "modernc.org/sqlite" // pure Go, so the tool builds without CGO
)

// Options configures an import.
type Options struct {
	// SQLitePath is the D1 database file, as wrangler stores it locally.
	SQLitePath string
	// Tables restricts the import, for a partial run during rehearsal. Empty means all.
	Tables []string
	// DryRun reads and validates everything without writing.
	DryRun bool
	// AllowNonEmpty skips the empty-target guard. Only for a deliberately merged database.
	AllowNonEmpty bool
}

// Result reports what was copied.
type Result struct {
	// Counts is rows written per table.
	Counts map[string]int
	// Skipped lists tables present in the source but not migrated, with the reason.
	Skipped map[string]string
}

// table pairs a D1 table with its PostgreSQL destination.
type table struct {
	source string
	target string
	// rename maps a source column to its destination name. The only difference between the
	// schemas is the unit naming: the server calls a bookable property a "unit".
	rename map[string]string
	// drop lists source columns with no destination. An audit row records who acted, which
	// D1 did not track.
	drop []string
	// requires lists source tables that must be imported first, so foreign keys resolve.
	requires []string
	// upsert makes the insert update on conflict instead.
	//
	// Needed for tenant_state, whose row the accounts table's trigger already creates: a
	// plain insert would collide, and the source's version is the one that matters because it
	// is what desktop clients have as their cursor.
	upsert []string
	// skipReason, when set, means the table is deliberately NOT migrated. Carrying these
	// over would be worse than leaving them: sessions and one-time codes are credential
	// material tied to the old deployment, and the new server issues its own.
	skipReason string
}

// tables lists every D1 table and what happens to it.
//
// Ordered so that referenced rows exist before the rows referencing them.
var tables = []table{
	// --- skipped, with the reason recorded so an operator knows it was a decision ---
	{source: "sessions", skipReason: "credentials for the old deployment; users sign in again"},
	{source: "verification_codes", skipReason: "one-time codes bound to the old deployment"},
	{source: "invites", skipReason: "pending invitations can be re-sent"},
	{source: "paddle_webhook_events", skipReason: "billing history for the subscription model that is being replaced"},
	{source: "billing_checkouts", skipReason: "subscription checkout rows; the product now sells a one-time licence"},
	{source: "billing_subscriptions", skipReason: "subscription rows; superseded by account_entitlements"},
	{source: "d1_migrations", skipReason: "Cloudflare's own migration bookkeeping"},
	{source: "_cf_METADATA", skipReason: "Cloudflare internal"},

	// --- migrated ---
	{source: "accounts", target: "accounts"},
	{source: "users", target: "users", requires: []string{"accounts"}},
	{source: "places", target: "places"},
	{source: "properties", target: "units", rename: map[string]string{"property_id": "unit_id"}, requires: []string{"places"}},
	{
		source: "reservations", target: "reservations",
		rename:   map[string]string{"property_id": "unit_id"},
		requires: []string{"units"},
	},
	{
		source: "reservation_nights", target: "reservation_nights",
		rename:   map[string]string{"property_id": "unit_id"},
		requires: []string{"reservations"},
	},
	{source: "reservation_services", target: "reservation_services", requires: []string{"reservations"}},
	{source: "reservation_meals", target: "reservation_meals", requires: []string{"reservations"}},
	{source: "app_settings", target: "app_settings"},
	// The watermark carries over so desktop clients resume from their existing cursor
	// instead of re-downloading everything.
	{source: "tenant_state", target: "tenant_state", requires: []string{"accounts"}, upsert: []string{"tenant_id"}},
	{source: "audit_log", target: "audit_log", drop: []string{"version", "deleted_at", "updated_at"}},
}

// OpenSource opens the D1 file read-only.
func OpenSource(path string) (*sql.DB, error) {
	// mode=ro so a mistakenly wrong path cannot create an empty database and then "migrate"
	// nothing while reporting success.
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("open D1 database: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("read D1 database %s: %w", path, err)
	}
	return db, nil
}

// sourceTables lists the tables that actually exist in the source.
func sourceTables(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		return nil, fmt.Errorf("list D1 tables: %w", err)
	}
	defer rows.Close()

	found := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		found[name] = true
	}
	return found, rows.Err()
}

// sourceColumns lists a table's columns.
func sourceColumns(db *sql.DB, table string) ([]string, error) {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", quoteIdentifier(table)))
	if err != nil {
		return nil, fmt.Errorf("read %s columns: %w", table, err)
	}
	defer rows.Close()

	var columns []string
	for rows.Next() {
		var (
			cid        int
			name       string
			columnType string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultVal, &pk); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

// quoteIdentifier wraps an identifier in double quotes, escaping any embedded quote.
//
// SQLite accepts a quoted identifier for a table name in PRAGMA, which is what allows the
// table name to come from a list rather than being interpolated bare.
func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// ErrTargetNotEmpty is returned when the destination already holds data.
var ErrTargetNotEmpty = errors.New("the target database is not empty")

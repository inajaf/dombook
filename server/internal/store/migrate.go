package store

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// migrations holds the schema SQL at build time. Embedding it removes the
// goose-binary-from-PATH dependency that a shell-out approach would impose on
// every environment that runs the server (containers, CI, a developer's laptop).
//
// The SQL lives in internal/store/migrations rather than at the server root
// because a //go:embed directive cannot reference a parent directory. The store
// package is also the only thing that executes migrations, so colocating them
// keeps the schema next to its sole consumer.
//
// The same files drive the goose CLI (`goose -dir internal/store/migrations ...`)
// when a manual up/down is wanted; both paths record state in goose_db_version.
//
//go:embed migrations/*.sql
var migrations embed.FS

// migrationsFSDir is the directory inside the embedded filesystem.
const migrationsFSDir = "migrations"

// Migrate brings the database to the latest schema, applying any pending
// migrations in filename order. It is safe to call on every start: applied
// migrations are recorded in goose_db_version and skipped.
//
// Each migration runs in its own transaction except when it declares otherwise
// (the `.sql` files carry goose's "no transaction" annotation, because
// `CREATE EXTENSION` and `ALTER TABLE ... ADD CONSTRAINT ... EXCLUDE` cannot run
// inside a transaction block).
func Migrate(ctx context.Context, dsn string) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect for migrations: %w", err)
	}
	defer pool.Close()

	if err := ensureVersionTable(ctx, pool); err != nil {
		return err
	}

	applied, err := appliedVersions(ctx, pool)
	if err != nil {
		return err
	}

	entries, err := migrationFiles()
	if err != nil {
		return err
	}

	for _, entry := range entries {
		version, name, err := parseMigrationName(entry)
		if err != nil {
			return err
		}
		if _, done := applied[version]; done {
			continue
		}
		body, err := migrations.ReadFile(migrationsFSDir + "/" + entry)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", entry, err)
		}
		if err := applyMigration(ctx, pool, version, name, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", entry, err)
		}
	}
	return nil
}

// MigrationStatus reports which migrations are applied, for `server migrate status`.
type MigrationStatus struct {
	Version string
	Name    string
	Applied bool
}

// Status returns the applied state of every known migration.
func Status(ctx context.Context, dsn string) ([]MigrationStatus, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect for status: %w", err)
	}
	defer pool.Close()

	if err := ensureVersionTable(ctx, pool); err != nil {
		return nil, err
	}
	applied, err := appliedVersions(ctx, pool)
	if err != nil {
		return nil, err
	}
	entries, err := migrationFiles()
	if err != nil {
		return nil, err
	}

	statuses := make([]MigrationStatus, 0, len(entries))
	for _, entry := range entries {
		version, name, err := parseMigrationName(entry)
		if err != nil {
			return nil, err
		}
		_, done := applied[version]
		statuses = append(statuses, MigrationStatus{Version: version, Name: name, Applied: done})
	}
	return statuses, nil
}

func ensureVersionTable(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS goose_db_version (
			id          serial PRIMARY KEY,
			version_id  bigint NOT NULL,
			is_applied  boolean NOT NULL,
			tstamp      timestamp DEFAULT now()
		)`)
	if err != nil {
		return fmt.Errorf("create goose_db_version: %w", err)
	}
	return nil
}

// appliedVersions reads the set of applied migration versions. A version counts
// as applied only if its newest record says so, which is what makes the
// down-then-up cycle in tests behave correctly.
func appliedVersions(ctx context.Context, pool *pgxpool.Pool) (map[string]struct{}, error) {
	rows, err := pool.Query(ctx, `
		SELECT version_id, is_applied
		FROM goose_db_version
		ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("read goose_db_version: %w", err)
	}
	defer rows.Close()

	applied := map[string]struct{}{}
	for rows.Next() {
		var version int64
		var isApplied bool
		if err := rows.Scan(&version, &isApplied); err != nil {
			return nil, err
		}
		key := fmt.Sprintf("%014d", version)
		if isApplied {
			applied[key] = struct{}{}
		} else {
			delete(applied, key)
		}
	}
	return applied, rows.Err()
}

// migrationFiles lists the embedded .sql files in ascending version order.
func migrationFiles() ([]string, error) {
	entries, err := migrations.ReadDir(migrationsFSDir)
	if err != nil {
		return nil, fmt.Errorf("list embedded migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		names = append(names, entry.Name())
	}
	// Filenames are zero-padded timestamps, so lexical order is version order.
	// Sorting explicitly rather than trusting ReadDir keeps that independent of
	// filesystem behavior.
	sort.Strings(names)
	if len(names) == 0 {
		return nil, fmt.Errorf("no migrations found in the embedded %s directory", migrationsFSDir)
	}
	return names, nil
}

// parseMigrationName splits "20260811000001_baseline.sql" into its version
// ("20260811000001", zero-padded to the 14-digit width goose uses) and name.
func parseMigrationName(filename string) (version, name string, err error) {
	base := strings.TrimSuffix(filename, ".sql")
	underscore := strings.Index(base, "_")
	if underscore <= 0 {
		return "", "", fmt.Errorf("migration %q must be named <version>_<name>.sql", filename)
	}
	raw := base[:underscore]
	if len(raw) > 14 {
		return "", "", fmt.Errorf("migration %q has a version longer than 14 digits", filename)
	}
	padded := raw
	for len(padded) < 14 {
		padded += "0"
	}
	return padded, base[underscore+1:], nil
}

// migrationBody splits a goose SQL file into its Up statements, honoring
// StatementBegin/StatementEnd blocks so that dollar-quoted bodies are kept whole
// rather than split on their internal semicolons.
func migrationBody(body string) (up string, noTransaction bool) {
	lines := strings.Split(body, "\n")
	var upLines []string
	inUp := false
	inBlock := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		switch {
		case strings.HasPrefix(trimmed, "-- +goose Up"):
			inUp = true
			continue
		case strings.HasPrefix(trimmed, "-- +goose Down"):
			inUp = false
			continue
		case strings.HasPrefix(trimmed, "-- +goose StatementBegin"):
			inBlock = true
			continue
		case strings.HasPrefix(trimmed, "-- +goose StatementEnd"):
			inBlock = false
			continue
		case strings.HasPrefix(trimmed, "-- +goose NO TRANSACTION"):
			noTransaction = true
			continue
		}

		if inUp {
			upLines = append(upLines, line)
		}
		_ = inBlock
	}

	return strings.Join(upLines, "\n"), noTransaction
}

// splitStatements breaks a migration body into executable statements.
//
// A naive strings.Split(body, ";") is wrong twice over, and both mistakes are
// silent — they produce a syntax error far from the real cause:
//
//  1. semicolons inside dollar-quoted blocks (PL/pgSQL function bodies,
//     DO $$ ... $$) do not terminate a statement;
//  2. semicolons inside comments and string literals do not either, and every
//     schema file is heavily commented.
//
// So this tracks three pieces of state: the active dollar-quote tag, the active
// single/double quote, and whether a line comment is in progress.
func splitStatements(body string) []string {
	var statements []string
	var current strings.Builder
	var dollarTag string
	var inSingle, inDouble, inLineComment bool

	runes := []rune(body)
	for i := 0; i < len(runes); i++ {
		r := runes[i]

		if inLineComment {
			if r == '\n' {
				inLineComment = false
				current.WriteRune(r)
			}
			continue
		}
		if inSingle {
			if r == '\'' {
				inSingle = false
			}
			current.WriteRune(r)
			continue
		}
		if inDouble {
			if r == '"' {
				inDouble = false
			}
			current.WriteRune(r)
			continue
		}
		if dollarTag != "" {
			// Inside a dollar-quoted body only the matching tag closes it.
			if r == '$' {
				if tag, width := readDollarTag(runes[i:]); tag == dollarTag {
					current.WriteString(string(runes[i : i+width]))
					i += width - 1
					dollarTag = ""
					continue
				}
			}
			current.WriteRune(r)
			continue
		}

		switch {
		case r == '-' && i+1 < len(runes) && runes[i+1] == '-':
			inLineComment = true
			i++
			continue
		case r == '\'':
			inSingle = true
		case r == '"':
			inDouble = true
		case r == '$':
			if tag, width := readDollarTag(runes[i:]); tag != "" {
				dollarTag = tag
				current.WriteString(string(runes[i : i+width]))
				i += width - 1
				continue
			}
		case r == ';':
			if stmt := strings.TrimSpace(current.String()); stmt != "" {
				statements = append(statements, stmt)
			}
			current.Reset()
			continue
		}
		current.WriteRune(r)
	}

	if stmt := strings.TrimSpace(current.String()); stmt != "" {
		statements = append(statements, stmt)
	}
	return statements
}

// readDollarTag returns the dollar-quote tag at the start of runes and its
// width, or "" when the input does not begin a dollar quote.
func readDollarTag(runes []rune) (string, int) {
	if len(runes) == 0 || runes[0] != '$' {
		return "", 0
	}
	for i := 1; i < len(runes); i++ {
		switch {
		case runes[i] == '$':
			return string(runes[:i+1]), i + 1
		case (runes[i] >= 'a' && runes[i] <= 'z') ||
			(runes[i] >= 'A' && runes[i] <= 'Z') ||
			(runes[i] >= '0' && runes[i] <= '9') ||
			runes[i] == '_':
			continue
		default:
			// A '$' not followed by a valid tag (e.g. a parameter placeholder
			// $1) is not a dollar quote.
			return "", 0
		}
	}
	return "", 0
}

func applyMigration(ctx context.Context, pool *pgxpool.Pool, version, name, body string) error {
	up, _ := migrationBody(body)
	statements := splitStatements(up)
	if len(statements) == 0 {
		return fmt.Errorf("migration has no Up statements")
	}

	// Like goose's "no transaction" .sql migrations, each statement is applied
	// independently. Statements that PostgreSQL can run in a transaction would
	// also be safe batched, but CREATE EXTENSION and ADD CONSTRAINT ... EXCLUDE
	// cannot be, and detecting that per statement is less reliable than simply
	// not wrapping. A failure is reported with its statement so the operator can
	// see exactly where it stopped.
	for i, statement := range statements {
		if _, err := pool.Exec(ctx, statement); err != nil {
			return fmt.Errorf("statement %d failed: %w", i+1, err)
		}
	}

	if _, err := pool.Exec(ctx,
		"INSERT INTO goose_db_version(version_id, is_applied) VALUES ($1, true)",
		version); err != nil {
		return fmt.Errorf("record migration version: %w", err)
	}
	return nil
}

// ResetTo drops every migration, used by tests to guarantee a known schema.
func ResetTo(ctx context.Context, dsn string, targetVersion string) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect for reset: %w", err)
	}
	defer pool.Close()

	if err := ensureVersionTable(ctx, pool); err != nil {
		return err
	}
	applied, err := appliedVersions(ctx, pool)
	if err != nil {
		return err
	}
	entries, err := migrationFiles()
	if err != nil {
		return err
	}

	// Walk downwards so foreign keys are dropped after their dependents.
	for i := len(entries) - 1; i >= 0; i-- {
		version, name, err := parseMigrationName(entries[i])
		if err != nil {
			return err
		}
		if _, done := applied[version]; !done {
			continue
		}
		body, err := migrations.ReadFile(migrationsFSDir + "/" + entries[i])
		if err != nil {
			return err
		}
		if err := revertMigration(ctx, pool, version, name, string(body)); err != nil {
			return fmt.Errorf("revert %s: %w", entries[i], err)
		}
	}
	return nil
}

func revertMigration(ctx context.Context, pool *pgxpool.Pool, version, name, body string) error {
	down := downBody(body)
	for i, statement := range splitStatements(down) {
		if _, err := pool.Exec(ctx, statement); err != nil {
			return fmt.Errorf("down statement %d failed: %w", i+1, err)
		}
	}
	if _, err := pool.Exec(ctx,
		"INSERT INTO goose_db_version(version_id, is_applied) VALUES ($1, false)",
		version); err != nil {
		return fmt.Errorf("record revert: %w", err)
	}
	return nil
}

// downBody extracts the Down section of a goose SQL file.
func downBody(body string) string {
	lines := strings.Split(body, "\n")
	var down []string
	inDown := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "-- +goose Down"):
			inDown = true
			continue
		case strings.HasPrefix(trimmed, "-- +goose Up"):
			inDown = false
			continue
		case strings.HasPrefix(trimmed, "-- +goose StatementBegin"),
			strings.HasPrefix(trimmed, "-- +goose StatementEnd"):
			// Directives are not SQL; drop them. The splitter handles the
			// dollar-quoted bodies they were protecting.
			continue
		}
		if inDown {
			down = append(down, line)
		}
	}
	return strings.Join(down, "\n")
}

// ResetAndMigrate rebuilds the schema from scratch inside ONE transaction on ONE
// connection.
//
// This exists because ResetTo followed by Migrate is not atomic: the two calls run
// on arbitrary pooled connections, so another session can observe the schema midway
// — after the old tables are dropped and before the new ones exist. In production
// nothing else is connected yet, but a test suite runs several package binaries
// against one database in parallel, and they do exactly this. The symptom is
// maddening: transient "function does not exist" or "relation does not exist"
// failures that pass on a rerun.
//
// PostgreSQL's transactional DDL makes the fix cheap: drop and recreate everything
// in a single transaction, so concurrent readers see either the old schema or the
// new one, never a gap. (This is why the migration runner can use per-statement
// commits for real deployments while tests need the stronger guarantee.)
//
// The caller is expected to hold an advisory lock so two binaries do not both try to
// rebuild at once; the transaction makes an unlucky reader safe, but it cannot make
// two concurrent rebuilds sensible.
func ResetAndMigrate(ctx context.Context, dsn string) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect for schema rebuild: %w", err)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire rebuild connection: %w", err)
	}
	defer conn.Release()

	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin schema rebuild: %w", err)
	}
	// Rollback after a successful commit is a no-op, so this is safe unconditionally
	// and covers a panic mid-rebuild.
	defer func() { _ = tx.Rollback(ctx) }()

	if err := resetSchemaInTx(ctx, tx); err != nil {
		return err
	}
	if err := migrateInTx(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit schema rebuild: %w", err)
	}
	return nil
}

// resetSchemaInTx reverts every applied migration inside an existing transaction.
func resetSchemaInTx(ctx context.Context, tx pgx.Tx) error {
	if err := ensureVersionTableTx(ctx, tx); err != nil {
		return err
	}
	applied, err := appliedVersionsTx(ctx, tx)
	if err != nil {
		return err
	}
	entries, err := migrationFiles()
	if err != nil {
		return err
	}

	// Walk downwards so a table is dropped before the objects it depends on.
	for i := len(entries) - 1; i >= 0; i-- {
		version, _, err := parseMigrationName(entries[i])
		if err != nil {
			return err
		}
		if _, done := applied[version]; !done {
			continue
		}
		body, err := migrations.ReadFile(migrationsFSDir + "/" + entries[i])
		if err != nil {
			return err
		}
		for index, statement := range splitStatements(downBody(string(body))) {
			if _, err := tx.Exec(ctx, statement); err != nil {
				return fmt.Errorf("revert %s: statement %d: %w", entries[i], index+1, err)
			}
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO goose_db_version(version_id, is_applied) VALUES ($1, false)", version); err != nil {
			return fmt.Errorf("record revert of %s: %w", entries[i], err)
		}
	}
	return nil
}

// migrateInTx applies every pending migration inside an existing transaction.
func migrateInTx(ctx context.Context, tx pgx.Tx) error {
	if err := ensureVersionTableTx(ctx, tx); err != nil {
		return err
	}
	applied, err := appliedVersionsTx(ctx, tx)
	if err != nil {
		return err
	}
	entries, err := migrationFiles()
	if err != nil {
		return err
	}

	for _, entry := range entries {
		version, _, err := parseMigrationName(entry)
		if err != nil {
			return err
		}
		if _, done := applied[version]; done {
			continue
		}
		body, err := migrations.ReadFile(migrationsFSDir + "/" + entry)
		if err != nil {
			return err
		}
		up, _ := migrationBody(string(body))
		for index, statement := range splitStatements(up) {
			if _, err := tx.Exec(ctx, statement); err != nil {
				return fmt.Errorf("migration %s: statement %d: %w", entry, index+1, err)
			}
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO goose_db_version(version_id, is_applied) VALUES ($1, true)", version); err != nil {
			return fmt.Errorf("record migration %s: %w", entry, err)
		}
	}
	return nil
}

func ensureVersionTableTx(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS goose_db_version (
			id          serial PRIMARY KEY,
			version_id  bigint NOT NULL,
			is_applied  boolean NOT NULL,
			tstamp      timestamp DEFAULT now()
		)`)
	if err != nil {
		return fmt.Errorf("create goose_db_version: %w", err)
	}
	return nil
}

func appliedVersionsTx(ctx context.Context, tx pgx.Tx) (map[string]struct{}, error) {
	rows, err := tx.Query(ctx, `SELECT version_id, is_applied FROM goose_db_version ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("read goose_db_version: %w", err)
	}
	defer rows.Close()

	applied := map[string]struct{}{}
	for rows.Next() {
		var version int64
		var isApplied bool
		if err := rows.Scan(&version, &isApplied); err != nil {
			return nil, err
		}
		key := fmt.Sprintf("%014d", version)
		if isApplied {
			applied[key] = struct{}{}
		} else {
			delete(applied, key)
		}
	}
	return applied, rows.Err()
}

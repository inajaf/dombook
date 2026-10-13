package d1import

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Run imports the source database into PostgreSQL.
//
// The whole import is one transaction. A migration that half-applies is worse than one that
// fails: the operator cannot tell which rows arrived, and re-running would duplicate them.
// So either every table lands or none does, and a failure can be fixed and retried.
func Run(ctx context.Context, source *sql.DB, pool pgxpoolPool, options Options) (*Result, error) {
	existing, err := sourceTables(source)
	if err != nil {
		return nil, err
	}

	// Which tables this run covers.
	selected := map[string]bool{}
	if len(options.Tables) > 0 {
		for _, name := range options.Tables {
			selected[name] = true
		}
	}

	plan := make([]table, 0, len(tables))
	for _, entry := range tables {
		if !existing[entry.source] {
			continue
		}
		if len(selected) > 0 && !selected[entry.target] && !selected[entry.source] {
			continue
		}
		// A table that must be imported first must also be in this run, or the rows would
		// reference something that does not exist.
		if len(selected) > 0 {
			for _, requirement := range entry.requires {
				if !selected[requirement] {
					return nil, fmt.Errorf("table %q requires %q, but a partial import was requested without it", entry.source, requirement)
				}
			}
		}
		plan = append(plan, entry)
	}

	result := &Result{Counts: map[string]int{}, Skipped: map[string]string{}}
	for _, entry := range tables {
		if !existing[entry.source] {
			continue
		}
		if entry.skipReason != "" {
			result.Skipped[entry.source] = entry.skipReason
		}
	}

	if options.DryRun {
		// A dry run still reads and converts every row, so a type or column problem surfaces
		// before the real run rather than halfway through it.
		for _, entry := range plan {
			if entry.skipReason != "" {
				continue
			}
			rows, err := readRows(source, entry)
			if err != nil {
				return nil, err
			}
			result.Counts[entry.target] = len(rows)
		}
		return result, nil
	}

	err = pool.WithTransaction(ctx, func(tx pgx.Tx) error {
		// The empty-target guard runs inside the transaction, so two concurrent imports
		// cannot both pass it.
		if !options.AllowNonEmpty {
			empty, err := targetIsEmpty(ctx, tx, plan)
			if err != nil {
				return err
			}
			if !empty {
				return ErrTargetNotEmpty
			}
		}

		for _, entry := range plan {
			if entry.skipReason != "" {
				continue
			}
			rows, err := readRows(source, entry)
			if err != nil {
				return err
			}
			if err := insertRows(ctx, tx, entry, rows); err != nil {
				return err
			}
			result.Counts[entry.target] = len(rows)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// pgxpoolPool is the narrow slice of the pool this package needs.
//
// An interface rather than the concrete pool so a test can supply a wrapper over the real
// database without this package importing the pool type and its configuration.
type pgxpoolPool interface {
	WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error
}

// targetIsEmpty reports whether any destination table already holds rows.
//
// Checked with a plain count rather than a guard on one table, because an operator who
// half-ran an older tool would have rows somewhere unexpected, and importing on top would
// duplicate them under new ids.
func targetIsEmpty(ctx context.Context, tx pgx.Tx, plan []table) (bool, error) {
	for _, entry := range plan {
		if entry.skipReason != "" {
			continue
		}
		var count int
		if err := tx.QueryRow(ctx, fmt.Sprintf("SELECT COUNT(*) FROM %s", quoteIdentifier(entry.target))).Scan(&count); err != nil {
			return false, fmt.Errorf("count %s: %w", entry.target, err)
		}
		if count > 0 {
			return false, nil
		}
	}
	return true, nil
}

// row is one source row, keyed by destination column name.
type row map[string]any

// readRows reads a table and converts its rows to the destination shape.
func readRows(source *sql.DB, entry table) ([]row, error) {
	columns, err := sourceColumns(source, entry.source)
	if err != nil {
		return nil, err
	}

	// Map source columns to destination columns, dropping those with nowhere to go.
	type pair struct{ from, to string }
	var pairs []pair
	for _, column := range columns {
		if contains(entry.drop, column) {
			continue
		}
		target := column
		if renamed, ok := entry.rename[column]; ok {
			target = renamed
		}
		pairs = append(pairs, pair{from: column, to: target})
	}
	if len(pairs) == 0 {
		return nil, fmt.Errorf("table %s has no migratable columns", entry.source)
	}

	fromNames := make([]string, len(pairs))
	for i, p := range pairs {
		fromNames[i] = quoteIdentifier(p.from)
	}

	query := fmt.Sprintf("SELECT %s FROM %s", strings.Join(fromNames, ", "), quoteIdentifier(entry.source))
	// Ordered so a failed run produces a reproducible error rather than a random one, and so
	// the insert order is deterministic for a source with foreign keys.
	query += " ORDER BY " + quoteIdentifier(pairs[0].from)

	result, err := source.Query(query)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", entry.source, err)
	}
	defer result.Close()

	var rows []row
	for result.Next() {
		values := make([]any, len(pairs))
		destinations := make([]any, len(pairs))
		for i := range values {
			destinations[i] = &values[i]
		}
		if err := result.Scan(destinations...); err != nil {
			return nil, fmt.Errorf("scan %s: %w", entry.source, err)
		}

		converted := make(row, len(pairs))
		for i, p := range pairs {
			converted[p.to] = convert(values[i])
		}

		// The tenant column: D1 calls it tenant_id on the child tables, and the destination
		// does too, so no rename is needed — but accounts are addressed by id, so a
		// tenant_state row and an account row have to agree.
		rows = append(rows, converted)
	}
	if err := result.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", entry.source, err)
	}
	return rows, nil
}

// convert adapts a SQLite value to what PostgreSQL will accept.
//
// The only real case is []byte: modernc returns TEXT as a string but can hand back a byte
// slice for some column types, and pgx would then store it as bytea rather than text.
func convert(value any) any {
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case int64:
		// Booleans live as 0/1 integers in SQLite and as boolean in PostgreSQL. Passing the
		// integer through would be rejected by the column type, so the destination decides:
		// a value that reaches a boolean column is converted below, in the insert.
		return typed
	default:
		return value
	}
}

// booleanColumns names the destination columns that are booleans, so an integer 0/1 from
// SQLite is converted rather than rejected.
var booleanColumns = map[string]bool{
	"has_food_service": true,
}

// insertRows writes the rows into the destination table.
//
// Column lists are built from the data, so a source table missing a column simply omits it
// and the destination's default applies. That is what lets the tool survive a D1 database
// created by an older migration without a hardcoded per-table column list that would drift.
func insertRows(ctx context.Context, tx pgx.Tx, entry table, rows []row) error {
	if len(rows) == 0 {
		return nil
	}

	// Every row contributes its columns, because a SQLite table can hold rows with different
	// shapes after an ALTER TABLE ADD COLUMN.
	columnSet := map[string]bool{}
	for _, r := range rows {
		for column := range r {
			columnSet[column] = true
		}
	}
	columns := make([]string, 0, len(columnSet))
	for column := range columnSet {
		columns = append(columns, column)
	}
	sort.Strings(columns)

	placeholders := make([]string, len(columns))
	for i, column := range columns {
		placeholder := fmt.Sprintf("$%d", i+1)
		// An explicit cast where the destination type differs from what SQLite reported.
		// pgx cannot infer the type of a parameter that is a Go int64 going into a boolean
		// column, and will send it as bigint and fail.
		if booleanColumns[column] {
			placeholder += "::boolean"
		}
		if column == "payload_json" || column == "metadata" || column == "booking_policy" || column == "conflict_details" {
			placeholder += "::jsonb"
		}
		placeholders[i] = placeholder
	}

	statement := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		quoteIdentifier(entry.target),
		strings.Join(quoted(columns), ", "),
		strings.Join(placeholders, ", "))

	// An upsert updates only the non-key columns, so the source's version wins while the key
	// stays. That is what carries a client's cursor across the cutover instead of forcing
	// every device to re-download the account.
	if len(entry.upsert) > 0 {
		updates := make([]string, 0, len(columns))
		for _, column := range columns {
			if contains(entry.upsert, column) {
				continue
			}
			updates = append(updates, fmt.Sprintf("%s = EXCLUDED.%s", quoteIdentifier(column), quoteIdentifier(column)))
		}
		targets := make([]string, len(entry.upsert))
		for i, column := range entry.upsert {
			targets[i] = quoteIdentifier(column)
		}
		if len(updates) == 0 {
			// Nothing to update: the row already exists with the key's value, so doing
			// nothing is the correct outcome rather than an error.
			statement += fmt.Sprintf(" ON CONFLICT (%s) DO NOTHING", strings.Join(targets, ", "))
		} else {
			statement += fmt.Sprintf(" ON CONFLICT (%s) DO UPDATE SET %s",
				strings.Join(targets, ", "), strings.Join(updates, ", "))
		}
	}

	for index, r := range rows {
		values := make([]any, len(columns))
		for i, column := range columns {
			value, present := r[column]
			if !present {
				values[i] = nil
				continue
			}
			if booleanColumns[column] {
				values[i] = truthy(value)
				continue
			}
			values[i] = value
		}
		if _, err := tx.Exec(ctx, statement, values...); err != nil {
			// The row's key is included because a bare constraint error in a migration of
			// thousands of rows says nothing about which one failed.
			identifier := ""
			if id, ok := r["id"].(string); ok {
				identifier = id
			} else if tenant, ok := r["tenant_id"].(string); ok {
				identifier = tenant
			}
			return fmt.Errorf("insert %s row %d (%s): %w", entry.target, index, identifier, err)
		}
	}
	return nil
}

// truthy converts a SQLite 0/1 into a Go bool.
func truthy(value any) bool {
	switch typed := value.(type) {
	case int64:
		return typed != 0
	case bool:
		return typed
	case string:
		return typed == "1" || strings.EqualFold(typed, "true")
	default:
		return false
	}
}

func quoted(names []string) []string {
	out := make([]string, len(names))
	for i, name := range names {
		out[i] = quoteIdentifier(name)
	}
	return out
}

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

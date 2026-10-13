// Command migrate-d1 copies an existing Cloudflare D1 database into PostgreSQL.
//
// This is the cutover tool. It is deliberately a separate command from the schema migrator:
// applying migrations is routine and idempotent, while moving production data is a one-time
// operation that has to refuse to run twice.
//
// Usage:
//
//	go run ./cmd/migrate-d1 -source <d1.sqlite> -dry-run
//	go run ./cmd/migrate-d1 -source <d1.sqlite>
//
// The destination comes from DOMBOOK_DSN, the same variable the server reads, so there is no
// second place for the connection string to be wrong.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/inajaf/dombook/server/internal/d1import"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/jackc/pgx/v5"
)

// poolAdapter exposes the store's pool as the narrow interface the importer needs.
//
// The importer takes an interface rather than the concrete pool so it can be tested without a
// live database, and the adapter keeps that from leaking into the command.
type poolAdapter struct {
	pool interface {
		Begin(ctx context.Context) (pgx.Tx, error)
	}
}

func (p poolAdapter) WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func main() {
	source := flag.String("source", "", "path to the D1 SQLite database file (required)")
	dryRun := flag.Bool("dry-run", false, "read and validate every row without writing anything")
	allowNonEmpty := flag.Bool("allow-non-empty", false, "skip the empty-target guard; only for a deliberate merge")
	tablesFlag := flag.String("tables", "", "comma-separated destination tables to import (partial rehearsal)")
	flag.Parse()

	if *source == "" {
		fmt.Fprintln(os.Stderr, "usage: migrate-d1 -source <d1.sqlite> [-dry-run] [-tables a,b]")
		os.Exit(2)
	}

	dsn := os.Getenv("DOMBOOK_DSN")
	if dsn == "" {
		log.Fatal("DOMBOOK_DSN is not set; it names the PostgreSQL destination")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	db, err := d1import.OpenSource(*source)
	if err != nil {
		log.Fatalf("open source: %v", err)
	}
	defer db.Close()

	pool, err := store.OpenPool(ctx, dsn)
	if err != nil {
		log.Fatalf("connect to PostgreSQL: %v", err)
	}
	defer pool.Close()

	var tables []string
	if *tablesFlag != "" {
		for _, name := range strings.Split(*tablesFlag, ",") {
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				tables = append(tables, trimmed)
			}
		}
	}

	options := d1import.Options{
		SQLitePath:    *source,
		Tables:        tables,
		DryRun:        *dryRun,
		AllowNonEmpty: *allowNonEmpty,
	}

	result, err := d1import.Run(ctx, db, poolAdapter{pool: pool}, options)
	if err != nil {
		if errors.Is(err, d1import.ErrTargetNotEmpty) {
			log.Fatal("the destination already contains data. Importing on top would duplicate it " +
				"under new rows with no way to tell them apart. Use a fresh database, or " +
				"-allow-non-empty if you are certain.")
		}
		log.Fatalf("import failed, nothing was written: %v", err)
	}

	if *dryRun {
		fmt.Println("dry run: nothing was written")
	}

	names := make([]string, 0, len(result.Counts))
	for name := range result.Counts {
		names = append(names, name)
	}
	sort.Strings(names)

	fmt.Println("rows imported:")
	total := 0
	for _, name := range names {
		fmt.Printf("  %-22s %d\n", name, result.Counts[name])
		total += result.Counts[name]
	}
	fmt.Printf("  %-22s %d\n", "TOTAL", total)

	if len(result.Skipped) > 0 {
		skipped := make([]string, 0, len(result.Skipped))
		for name := range result.Skipped {
			skipped = append(skipped, name)
		}
		sort.Strings(skipped)

		fmt.Println("\nnot migrated:")
		for _, name := range skipped {
			fmt.Printf("  %-22s %s\n", name, result.Skipped[name])
		}
	}

	if !*dryRun && total > 0 {
		fmt.Println("\nUsers keep their existing data. Desktop clients resume from their stored cursor,")
		fmt.Println("so they will not re-download. Sessions are not migrated: everyone signs in again.")
	}
}

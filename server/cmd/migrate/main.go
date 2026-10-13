// Command migrate applies or inspects RentKeeper database migrations.
//
// Usage:
//
//	migrate up                 apply all pending migrations
//	migrate status             list migrations and whether they are applied
//	migrate reset              drop every migration (DEVELOPMENT ONLY)
//
// The DSN comes from DOMBOOK_DSN, or from the first positional argument after
// the subcommand. Exit code is non-zero when the requested action fails, so CI
// can gate on it.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/inajaf/dombook/server/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "migrate: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	if len(args) == 0 {
		return fmt.Errorf("usage: migrate <up|status|reset> [dsn]")
	}

	action := args[0]
	dsn := os.Getenv("DOMBOOK_DSN")
	if len(args) > 1 {
		dsn = args[1]
	}
	if dsn == "" {
		return fmt.Errorf("no database DSN: set DOMBOOK_DSN or pass it as the second argument")
	}

	ctx := context.Background()
	switch action {
	case "up":
		if err := store.Migrate(ctx, dsn); err != nil {
			return err
		}
		return printStatus(ctx, dsn)

	case "status":
		return printStatus(ctx, dsn)

	case "reset":
		// Dropping every table is destructive and must never be reachable in
		// production by a stray command. Requiring the same variable the tests
		// use keeps it a deliberate, local act.
		if os.Getenv("DOMBOOK_ALLOW_RESET") != "1" {
			return fmt.Errorf("reset drops all data; set DOMBOOK_ALLOW_RESET=1 to confirm")
		}
		if err := store.ResetTo(ctx, dsn, ""); err != nil {
			return err
		}
		fmt.Println("all migrations reverted")
		return nil

	default:
		return fmt.Errorf("unknown action %q: want up, status, or reset", action)
	}
}

func printStatus(ctx context.Context, dsn string) error {
	statuses, err := store.Status(ctx, dsn)
	if err != nil {
		return err
	}
	for _, status := range statuses {
		state := "pending"
		if status.Applied {
			state = "applied"
		}
		fmt.Printf("%-16s %-30s %s\n", status.Version, status.Name, state)
	}
	return nil
}

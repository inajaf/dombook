package store

import (
	"strings"
	"testing"
)

// The statement splitter is the most fragile part of the migration runner and it
// fails in a deceptive way: a mis-split file yields a PostgreSQL syntax error
// pointing at the wrong location. These cases pin each state that can hide a
// semicolon.

func TestSplitStatementsHandlesSemicolonsInComments(t *testing.T) {
	// The case that actually broke: prose in a comment containing a semicolon
	// split the statement in half, producing `syntax error at or near "RLS"`.
	body := `-- RLS is enabled for every table; see the list below.
ALTER TABLE units ENABLE ROW LEVEL SECURITY;`

	statements := splitStatements(body)
	if len(statements) != 1 {
		t.Fatalf("got %d statements, want 1: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "ENABLE ROW LEVEL SECURITY") {
		t.Errorf("statement lost its SQL: %q", statements[0])
	}
	if strings.Contains(statements[0], "see the list below") {
		t.Errorf("comment leaked into the statement: %q", statements[0])
	}
}

func TestSplitStatementsKeepsDollarQuotedBodiesWhole(t *testing.T) {
	body := `CREATE OR REPLACE FUNCTION f() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'boom; really';
  RETURN NEW;
END $$;
CREATE TRIGGER t AFTER INSERT ON units FOR EACH ROW EXECUTE FUNCTION f();`

	statements := splitStatements(body)
	if len(statements) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "END $$") {
		t.Errorf("function body was split: %q", statements[0])
	}
	if !strings.HasPrefix(statements[1], "CREATE TRIGGER") {
		t.Errorf("second statement is wrong: %q", statements[1])
	}
}

func TestSplitStatementsHandlesTaggedDollarQuotes(t *testing.T) {
	body := `DO $body$
BEGIN
  PERFORM 1;
END $body$;
SELECT 1;`

	statements := splitStatements(body)
	if len(statements) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "END $body$") {
		t.Errorf("tagged block was split: %q", statements[0])
	}
}

func TestSplitStatementsHandlesSemicolonsInStringLiterals(t *testing.T) {
	body := `INSERT INTO app_settings(tenant_id, setting_key, setting_value)
VALUES ('00000000-0000-0000-0000-000000000001', 'note', 'a; b; c');
SELECT 2;`

	statements := splitStatements(body)
	if len(statements) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "'a; b; c'") {
		t.Errorf("string literal was split: %q", statements[0])
	}
}

func TestSplitStatementsHandlesOperatorPlaceholders(t *testing.T) {
	// $1 is a parameter placeholder, not a dollar quote. Treating it as one
	// would swallow the rest of the file.
	body := `SELECT count(*) FROM units WHERE tenant_id = $1;
SELECT 2;`

	statements := splitStatements(body)
	if len(statements) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "$1") {
		t.Errorf("placeholder was mangled: %q", statements[0])
	}
}

func TestSplitStatementsIgnoresTrailingWhitespaceOnly(t *testing.T) {
	if statements := splitStatements("\n\n  \n"); len(statements) != 0 {
		t.Fatalf("got %d statements from blank input, want 0", len(statements))
	}
}

func TestMigrationBodyExtractsOnlyTheUpSection(t *testing.T) {
	body := `-- +goose Up
CREATE TABLE a (id int);
-- +goose StatementBegin
DO $$ BEGIN PERFORM 1; END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE a;`

	up, _ := migrationBody(body)
	if strings.Contains(up, "DROP TABLE") {
		t.Errorf("Up section contains Down SQL: %q", up)
	}
	if !strings.Contains(up, "CREATE TABLE a") {
		t.Errorf("Up section is missing its SQL: %q", up)
	}
	// Goose directives are not SQL and must not reach the database.
	if strings.Contains(up, "+goose") {
		t.Errorf("goose directives leaked into the SQL: %q", up)
	}

	down := downBody(body)
	if !strings.Contains(down, "DROP TABLE a") {
		t.Errorf("Down section is missing its SQL: %q", down)
	}
	if strings.Contains(down, "CREATE TABLE a") {
		t.Errorf("Down section contains Up SQL: %q", down)
	}
}

func TestParseMigrationName(t *testing.T) {
	version, name, err := parseMigrationName("20260811000001_baseline.sql")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if version != "20260811000001" {
		t.Errorf("version = %q, want 20260811000001", version)
	}
	if name != "baseline" {
		t.Errorf("name = %q, want baseline", name)
	}

	// A short version is padded so it compares consistently against goose's
	// bigint version_id column.
	version, _, err = parseMigrationName("42_short.sql")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if version != "42000000000000" {
		t.Errorf("version = %q, want 42000000000000", version)
	}

	for _, bad := range []string{"noseparator.sql", "_leading.sql", "12345678901234567890_toolong.sql"} {
		if _, _, err := parseMigrationName(bad); err == nil {
			t.Errorf("parseMigrationName(%q) should have failed", bad)
		}
	}
}

// TestEmbeddedMigrationsArePresent guards the build-time embedding: a rename or
// a move that breaks the //go:embed pattern would otherwise only surface when
// the server failed to start against an empty database.
func TestEmbeddedMigrationsArePresent(t *testing.T) {
	files, err := migrationFiles()
	if err != nil {
		t.Fatalf("list embedded migrations: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no embedded migrations found")
	}
	for _, name := range []string{
		"20260811000001_baseline.sql",
		"20260811000002_security.sql",
		"20260811000003_roles.sql",
		"20260811000004_bootstrap_functions.sql",
	} {
		found := false
		for _, got := range files {
			if got == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("embedded migrations are missing %s", name)
		}
	}
}

// TestEveryMigrationHasGooseDirectives catches a mistake that fails obscurely:
// a file without "-- +goose Up" yields no Up statements, and the runner reports
// "migration has no Up statements" rather than pointing at the missing marker.
// It also guarantees each migration is reversible, which the up/down/up cycle in
// server/README.md depends on.
func TestEveryMigrationHasGooseDirectives(t *testing.T) {
	files, err := migrationFiles()
	if err != nil {
		t.Fatalf("list embedded migrations: %v", err)
	}
	for _, name := range files {
		body, err := migrations.ReadFile(migrationsFSDir + "/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		content := string(body)
		if !strings.Contains(content, "-- +goose Up") {
			t.Errorf("%s has no '-- +goose Up' directive", name)
		}
		if !strings.Contains(content, "-- +goose Down") {
			t.Errorf("%s has no '-- +goose Down' directive, so it cannot be rolled back", name)
		}

		up, _ := migrationBody(content)
		if len(splitStatements(up)) == 0 {
			t.Errorf("%s produces no Up statements", name)
		}
		down := downBody(content)
		if len(splitStatements(down)) == 0 {
			t.Errorf("%s produces no Down statements", name)
		}
	}
}

package domain

import (
	"embed"
	"os"
	"path/filepath"
	"testing"
)

// testdata holds the shared domain fixtures embedded at build time, so the test
// binary is self-contained and does not depend on the working directory.
//
// These files are COPIES of fixtures/*.json at the repository root (go:embed
// cannot reference a parent directory). TestEmbeddedFixturesMatchCanonical
// fails the build if the copy drifts from the canonical source.
//
//go:embed testdata/*.json
var testdata embed.FS

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := testdata.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read embedded fixture %s: %v", name, err)
	}
	return data
}

// readCanonicalFixture reads the same fixture from the repository root, which is
// the source of truth shared with the JavaScript test suite.
func readCanonicalFixture(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join(repoRoot(t), "fixtures", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read canonical fixture %s: %v", path, err)
	}
	return data
}

// repoRoot walks up from the test's working directory (the package directory)
// until it finds the repository root, identified by go.mod two levels up. It
// fails loudly rather than returning a wrong path, so a moved test cannot quietly
// skip its parity check.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "fixtures")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not locate the repository root above %s", dir)
		}
		dir = parent
	}
}

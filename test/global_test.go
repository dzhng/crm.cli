package test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// --- Global Flags & Config ---

func TestVersion(t *testing.T) {
	tc := newTestContext(t)

	out := tc.runOK("--version")
	// Should print a version string.
	if strings.TrimSpace(out) == "" {
		t.Fatal("expected version output")
	}
}

func TestCustomDB(t *testing.T) {
	tc := newTestContext(t)

	// Use a custom DB path.
	customDB := filepath.Join(tc.dir, "custom.db")
	tc.runOK("--db", customDB, "contact", "add", "--name", "Jane")

	// Verify the custom DB file was created.
	if _, err := os.Stat(customDB); os.IsNotExist(err) {
		t.Fatal("expected custom DB file to exist")
	}

	// Verify data is in the custom DB.
	var contacts []map[string]interface{}
	tc.runJSON(&contacts, "--db", customDB, "contact", "list", "--format", "json")
	if len(contacts) != 1 {
		t.Fatalf("expected 1 contact in custom DB, got %d", len(contacts))
	}
}

func TestEnvVarDB(t *testing.T) {
	tc := newTestContext(t)

	customDB := filepath.Join(tc.dir, "env.db")

	// Create a contact using CRM_DB env var instead of --db flag.
	fullArgs := []string{"contact", "add", "--name", "Jane"}
	cmd := createCmd(tc, fullArgs...)
	cmd.Env = append(os.Environ(), "CRM_DB="+customDB)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("failed with CRM_DB env var: %v", err)
	}
	id := strings.TrimSpace(string(out))
	if !strings.HasPrefix(id, "ct_") {
		t.Fatalf("expected contact ID, got: %s", id)
	}
}

func TestEnvVarFormat(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane")

	// Use CRM_FORMAT env var to set default format.
	fullArgs := []string{"--db", tc.dbPath, "contact", "list"}
	cmd := createCmd(tc, fullArgs...)
	cmd.Env = append(os.Environ(), "CRM_FORMAT=json")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("failed with CRM_FORMAT env var: %v", err)
	}
	// Output should be valid JSON.
	if !strings.HasPrefix(strings.TrimSpace(string(out)), "[") {
		t.Fatalf("expected JSON array with CRM_FORMAT=json, got: %s", string(out))
	}
}

func TestNoColor(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane")

	// With --no-color, output should not contain ANSI escape codes.
	out := tc.runOK("contact", "list", "--no-color")
	if strings.Contains(out, "\033[") {
		t.Fatal("expected no ANSI escape codes with --no-color")
	}
}

func TestDBAutoCreated(t *testing.T) {
	tc := newTestContext(t)

	// The DB file shouldn't exist yet.
	if _, err := os.Stat(tc.dbPath); !os.IsNotExist(err) {
		t.Fatal("expected DB to not exist before first command")
	}

	tc.runOK("contact", "add", "--name", "Jane")

	// Now it should exist.
	if _, err := os.Stat(tc.dbPath); os.IsNotExist(err) {
		t.Fatal("expected DB to be auto-created after first command")
	}
}

func TestUnknownCommand(t *testing.T) {
	tc := newTestContext(t)

	_, stderr := tc.runFail("notacommand")
	if stderr == "" {
		t.Fatal("expected error message for unknown command")
	}
}

func TestHelpFlag(t *testing.T) {
	tc := newTestContext(t)

	out := tc.runOK("--help")
	assertContains(t, out, "contact")
	assertContains(t, out, "company")
	assertContains(t, out, "deal")
	assertContains(t, out, "search")
	assertContains(t, out, "find")
	assertContains(t, out, "report")
}

func TestSubcommandHelp(t *testing.T) {
	tc := newTestContext(t)

	out := tc.runOK("contact", "--help")
	assertContains(t, out, "add")
	assertContains(t, out, "list")
	assertContains(t, out, "show")
	assertContains(t, out, "edit")
	assertContains(t, out, "rm")
}

// createCmd is a helper that creates an exec.Cmd without the --db flag
// (for testing env var behavior).
func createCmd(tc *testContext, args ...string) *exec.Cmd {
	tc.t.Helper()
	cmd := exec.Command(crmBinary, args...)
	cmd.Dir = tc.dir
	return cmd
}

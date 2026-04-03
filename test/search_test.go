package test

import (
	"testing"
)

// --- Keyword Search (FTS5) ---

func TestSearch_ByName(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane Doe", "--email", "jane@acme.com")
	tc.runOK("contact", "add", "--name", "John Smith", "--email", "john@globex.com")

	out := tc.runOK("search", "Jane")
	assertContains(t, out, "Jane Doe")
	assertNotContains(t, out, "John Smith")
}

func TestSearch_ByEmail(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane Doe", "--email", "jane@acme.com")
	out := tc.runOK("search", "acme.com")
	assertContains(t, out, "Jane Doe")
}

func TestSearch_AcrossEntities(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane Doe", "--company", "Acme")
	tc.runOK("company", "add", "--name", "Acme Corp", "--domain", "acme.com")
	tc.runOK("deal", "add", "--title", "Acme Enterprise Deal")

	out := tc.runOK("search", "Acme")
	assertContains(t, out, "Jane Doe")
	assertContains(t, out, "Acme Corp")
	assertContains(t, out, "Acme Enterprise Deal")
}

func TestSearch_FilterByType(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Acme Person")
	tc.runOK("company", "add", "--name", "Acme Corp")

	out := tc.runOK("search", "Acme", "--type", "contact")
	assertContains(t, out, "Acme Person")
	assertNotContains(t, out, "Acme Corp")
}

func TestSearch_InActivityNotes(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane", "--email", "jane@acme.com")
	tc.runOK("log", "note", "jane@acme.com", "Discussed the enterprise pricing tier")

	out := tc.runOK("search", "enterprise pricing")
	assertContains(t, out, "enterprise pricing")
}

func TestSearch_NoResults(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane Doe")

	_ = tc.runOK("search", "zzzznonexistent")
	// Should succeed (exit 0) with empty results.
	var results []map[string]interface{}
	tc.runJSON(&results, "search", "zzzznonexistent", "--format", "json")
	if len(results) != 0 {
		t.Fatalf("expected 0 results, got %d", len(results))
	}
}

func TestSearch_JSON(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane Doe", "--email", "jane@acme.com")

	var results []map[string]interface{}
	tc.runJSON(&results, "search", "Jane", "--format", "json")
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0]["type"] != "contact" {
		t.Fatalf("expected type=contact, got %s", results[0]["type"])
	}
}

// --- Semantic Search ---
// These test the crm find command with local embeddings.

func TestFind_NaturalLanguage(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Alice Chen", "--title", "CTO", "--company", "FinTech London Ltd",
		"--set", "location=London")
	tc.runOK("contact", "add", "--name", "Bob Wilson", "--title", "Engineer", "--company", "Acme US")

	var results []map[string]interface{}
	tc.runJSON(&results, "find", "fintech CTO from London", "--format", "json")
	if len(results) == 0 {
		t.Fatal("expected at least 1 result for semantic search")
	}
	// The top result should be Alice (CTO at fintech in London).
	if results[0]["name"] != "Alice Chen" {
		t.Fatalf("expected Alice Chen as top result, got %s", results[0]["name"])
	}
}

func TestFind_Limit(t *testing.T) {
	tc := newTestContext(t)

	for i := 0; i < 5; i++ {
		tc.runOK("contact", "add", "--name", "Person "+string(rune('A'+i)))
	}

	var results []map[string]interface{}
	tc.runJSON(&results, "find", "person", "--limit", "2", "--format", "json")
	if len(results) > 2 {
		t.Fatalf("expected at most 2 results with --limit 2, got %d", len(results))
	}
}

func TestFind_FilterByType(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Acme Alice")
	tc.runOK("company", "add", "--name", "Acme Corp")

	var results []map[string]interface{}
	tc.runJSON(&results, "find", "acme", "--type", "contact", "--format", "json")
	for _, r := range results {
		if r["type"] != "contact" {
			t.Fatalf("expected only contact results, got %s", r["type"])
		}
	}
}

// --- Search Index ---

func TestIndexStatus(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane")
	out := tc.runOK("index", "status")
	assertContains(t, out, "contacts")
}

func TestIndexRebuild(t *testing.T) {
	tc := newTestContext(t)

	tc.runOK("contact", "add", "--name", "Jane")
	tc.runOK("index", "rebuild")

	// After rebuild, search should still work.
	out := tc.runOK("search", "Jane")
	assertContains(t, out, "Jane")
}

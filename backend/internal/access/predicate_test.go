package access

import (
	"os"
	"strings"
	"testing"
)

// TestChokePointPredicatesPresentInSource is a pure, DB-free characterization
// test proving design.md's choke points 12 (IsOrganizationAdmin) and 13
// (loadWorkspaceMetadata, the highest-leverage choke point in the whole
// inventory) actually landed as literal SQL text in this package's
// service.go. It has no external dependency (unlike the fakeQuerier-based
// tests beside it, which do not observe real SQL text at all) and always
// executes, giving a real RED -> GREEN proof for this session.
func TestChokePointPredicatesPresentInSource(t *testing.T) {
	source, err := os.ReadFile("service.go")
	if err != nil {
		t.Fatalf("read service.go: %v", err)
	}
	text := string(source)

	adminBody := chokePointFunctionBody(t, text, "func IsOrganizationAdmin(")
	if !strings.Contains(adminBody, "JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL") {
		t.Fatal("CP12: IsOrganizationAdmin's body does not contain the org-liveness JOIN")
	}

	metadataBody := chokePointFunctionBody(t, text, "func loadWorkspaceMetadata(")
	if !strings.Contains(metadataBody, "AND w.deleted_at IS NULL AND o.deleted_at IS NULL") {
		t.Fatal("CP13: loadWorkspaceMetadata's body does not contain the workspace+org liveness predicate")
	}
}

// chokePointFunctionBody returns the source text from the given function
// signature up to (but not including) the next top-level "func " token, so
// tests can assert on one function's body without depending on exact
// indentation elsewhere in the file.
func chokePointFunctionBody(t *testing.T, source, signature string) string {
	t.Helper()

	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("function signature %q not found in source", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return rest
	}
	return rest[:end]
}

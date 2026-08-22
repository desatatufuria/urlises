package workspaces

import (
	"os"
	"strings"
	"testing"
)

// TestChokePointPredicatesPresentInSource is a pure, DB-free characterization
// test proving design.md's choke points 14 (ListByOrganization), 15
// (loadWorkspaceMetadataRecord) and 16 (loadWorkspaceOrganizationID)
// actually landed as literal SQL text in this package's service.go. It has
// no external dependency and always executes, giving a real RED -> GREEN
// proof independent of WORKSPACES_TEST_DATABASE_URL/DATABASE_URL
// availability.
func TestChokePointPredicatesPresentInSource(t *testing.T) {
	source, err := os.ReadFile("service.go")
	if err != nil {
		t.Fatalf("read service.go: %v", err)
	}
	text := string(source)

	listBody := chokePointFunctionBody(t, text, "func (s *Service) ListByOrganization(")
	if !strings.Contains(listBody, "JOIN organizations o ON o.id = w.organization_id AND o.deleted_at IS NULL") {
		t.Fatal("CP14: ListByOrganization's body does not contain the org-liveness JOIN predicate")
	}
	if !strings.Contains(listBody, "WHERE w.organization_id = $2 AND w.deleted_at IS NULL") {
		t.Fatal("CP14: ListByOrganization's outer WHERE does not exclude soft-deleted workspaces")
	}

	metadataBody := chokePointFunctionBody(t, text, "func loadWorkspaceMetadataRecord(")
	if !strings.Contains(metadataBody, "WHERE w.id = $1 AND w.deleted_at IS NULL AND o.deleted_at IS NULL") {
		t.Fatal("CP15: loadWorkspaceMetadataRecord's body does not contain the workspace+org liveness predicate")
	}

	orgIDBody := chokePointFunctionBody(t, text, "func loadWorkspaceOrganizationID(")
	if !strings.Contains(orgIDBody, "WHERE id = $1 AND deleted_at IS NULL") {
		t.Fatal("CP16: loadWorkspaceOrganizationID's body does not contain the workspace liveness predicate")
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

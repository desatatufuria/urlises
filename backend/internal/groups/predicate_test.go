package groups

import (
	"os"
	"strings"
	"testing"
)

// TestChokePointPredicatesPresentInSource is a pure, DB-free characterization
// test proving design.md's choke point 11 (the group-membership EXISTS
// check) still lands as literal SQL text in this package's service.go, and
// that choke point 10 (the formerly-duplicated org-admin check) now
// delegates to access.RequireOrganizationAdmin instead of carrying its own
// copy of the JOIN. It has no external dependency and always executes,
// giving a real RED -> GREEN proof independent of
// GROUPS_TEST_DATABASE_URL/DATABASE_URL availability.
func TestChokePointPredicatesPresentInSource(t *testing.T) {
	source, err := os.ReadFile("service.go")
	if err != nil {
		t.Fatalf("read service.go: %v", err)
	}
	text := string(source)

	joinPredicate := "JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL"
	if count := strings.Count(text, joinPredicate); count != 1 {
		t.Fatalf("CP11: expected %q exactly 1 time (requireOrganizationMembership; requireOrganizationAdmin's own copy was consolidated into access.RequireOrganizationAdmin), got %d", joinPredicate, count)
	}

	adminBody := chokePointFunctionBody(t, text, "func requireOrganizationAdmin(")
	if !strings.Contains(adminBody, "access.RequireOrganizationAdmin(") {
		t.Fatal("CP10: requireOrganizationAdmin no longer delegates to access.RequireOrganizationAdmin")
	}
	if strings.Contains(adminBody, joinPredicate) {
		t.Fatal("CP10: requireOrganizationAdmin regained its own copy of the org-liveness JOIN")
	}

	membershipBody := chokePointFunctionBody(t, text, "func requireOrganizationMembership(")
	if !strings.Contains(membershipBody, joinPredicate) {
		t.Fatal("CP11: requireOrganizationMembership's body does not contain the org-liveness JOIN")
	}
	if !strings.Contains(membershipBody, "EXISTS(") {
		t.Fatal("CP11: requireOrganizationMembership no longer uses an EXISTS subquery shape")
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

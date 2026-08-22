package organizations

import (
	"os"
	"strings"
	"testing"
)

// TestChokePointPredicatesPresentInSource is a pure, DB-free characterization
// test proving design.md's "Choke points — exhaustive deleted_at IS NULL
// inventory" table (CP1, CP2, CP3, CP5, CP6, CP7, CP8, CP14) actually landed
// as literal SQL text in this package's service.go. Unlike the DB-backed
// named tests beside it (which require ORGANIZATIONS_TEST_DATABASE_URL/
// DATABASE_URL and skip cleanly without one), this test has no external
// dependency and always executes, giving a real RED (predicate text absent)
// -> GREEN (predicate text present) proof for this session.
func TestChokePointPredicatesPresentInSource(t *testing.T) {
	source, err := os.ReadFile("service.go")
	if err != nil {
		t.Fatalf("read service.go: %v", err)
	}
	text := string(source)

	// CP1 (ListMemberships), CP2 (loadOrganizationRole), CP3
	// (loadOrganizationMember) and CP14 (ListSecretRecipients' membership
	// subquery) all add the identical
	// "JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL"
	// shape, once each.
	membershipJoin := "JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL"
	if count := strings.Count(text, membershipJoin); count != 4 {
		t.Fatalf("CP1/CP2/CP3/CP14: expected %q exactly 4 times (ListMemberships, loadOrganizationRole, loadOrganizationMember, ListSecretRecipients), got %d", membershipJoin, count)
	}

	// CP5 (CreateInvitationTx context) and CP6 (ResendInvitation context)
	// share byte-identical query text, once each.
	invitationContextPredicate := "WHERE o.id = $1 AND o.deleted_at IS NULL"
	if count := strings.Count(text, invitationContextPredicate); count != 2 {
		t.Fatalf("CP5/CP6: expected %q exactly 2 times (CreateInvitationTx, ResendInvitation), got %d", invitationContextPredicate, count)
	}

	// CP7 (ValidatePendingInvitation) and CP8 (loadInvitationForUpdate) share
	// the identical JOIN shape, once each.
	invitationJoin := "JOIN organizations o ON o.id = i.organization_id AND o.deleted_at IS NULL"
	if count := strings.Count(text, invitationJoin); count != 2 {
		t.Fatalf("CP7/CP8: expected %q exactly 2 times (ValidatePendingInvitation, loadInvitationForUpdate), got %d", invitationJoin, count)
	}

	// CP14 — ListSecretRecipients' body must contain both the org-liveness
	// JOIN (the membership gate, per design.md Decision 3) and the
	// deactivated-user filter (Deviation 2), so the choke point cannot be
	// satisfied by an unrelated occurrence of the JOIN text elsewhere.
	recipientsBody := chokePointFunctionBody(t, text, "func (s *Service) ListSecretRecipients(")
	if !strings.Contains(recipientsBody, membershipJoin) {
		t.Fatal("CP14: ListSecretRecipients' body does not contain the org-liveness JOIN")
	}
	if !strings.Contains(recipientsBody, "u.disabled_at IS NULL") {
		t.Fatal("CP14: ListSecretRecipients' body does not contain u.disabled_at IS NULL")
	}
}

// chokePointFunctionBody returns the source text from the given function
// signature up to (but not including) the next top-level "func " token, so
// tests can assert on one function's body without depending on exact
// indentation elsewhere in the file. Mirrors groups/predicate_test.go's
// helper of the same name and shape.
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

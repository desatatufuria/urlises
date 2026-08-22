package organizations

import (
	"os"
	"strings"
	"testing"
)

// TestChokePointPredicatesPresentInSource is a pure, DB-free characterization
// test proving design.md's "Choke points — exhaustive deleted_at IS NULL
// inventory" table (CP1, CP2, CP3, CP5, CP6, CP7, CP8) actually landed as
// literal SQL text in this package's service.go. Unlike the DB-backed named
// tests beside it (which require ORGANIZATIONS_TEST_DATABASE_URL/
// DATABASE_URL and skip cleanly without one), this test has no external
// dependency and always executes, giving a real RED (predicate text absent)
// -> GREEN (predicate text present) proof for this session.
func TestChokePointPredicatesPresentInSource(t *testing.T) {
	source, err := os.ReadFile("service.go")
	if err != nil {
		t.Fatalf("read service.go: %v", err)
	}
	text := string(source)

	// CP1 (ListMemberships), CP2 (loadOrganizationRole) and CP3
	// (loadOrganizationMember) all add the identical
	// "JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL"
	// shape, once each.
	membershipJoin := "JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL"
	if count := strings.Count(text, membershipJoin); count != 3 {
		t.Fatalf("CP1/CP2/CP3: expected %q exactly 3 times (ListMemberships, loadOrganizationRole, loadOrganizationMember), got %d", membershipJoin, count)
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
}

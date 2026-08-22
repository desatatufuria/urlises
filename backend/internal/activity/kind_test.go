package activity

import "testing"

// TestKindOrganizationDeletedValue is a DB-free pure-logic test: it locks in
// the exact wire value organizations.DeleteOrganization records once soft
// delete lands (design.md Deviation 3, reversing lifecycle-management's
// "record nothing" decision now that nothing cascades the event away).
// RED: KindOrganizationDeleted does not exist yet, so this fails to compile.
func TestKindOrganizationDeletedValue(t *testing.T) {
	if KindOrganizationDeleted != Kind("organization.deleted") {
		t.Fatalf("KindOrganizationDeleted = %q, want %q", KindOrganizationDeleted, "organization.deleted")
	}
}

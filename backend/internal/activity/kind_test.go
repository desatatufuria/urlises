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

// TestBookmarkFolderKindValues is a DB-free pure-logic test: it locks in the
// 6 new Kind wire values that bookmark-activity-audit's sync.PostgresStore
// will record once wiring lands (design.md Interfaces / Contracts).
// RED: the 6 constants do not exist yet, so this fails to compile.
func TestBookmarkFolderKindValues(t *testing.T) {
	cases := []struct {
		name string
		kind Kind
		want string
	}{
		{"KindBookmarkCreated", KindBookmarkCreated, "bookmark.created"},
		{"KindBookmarkUpdated", KindBookmarkUpdated, "bookmark.updated"},
		{"KindBookmarkDeleted", KindBookmarkDeleted, "bookmark.deleted"},
		{"KindFolderCreated", KindFolderCreated, "folder.created"},
		{"KindFolderUpdated", KindFolderUpdated, "folder.updated"},
		{"KindFolderDeleted", KindFolderDeleted, "folder.deleted"},
	}

	for _, c := range cases {
		if string(c.kind) != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.kind, c.want)
		}
	}
}

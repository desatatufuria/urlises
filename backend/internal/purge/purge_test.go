package purge

import (
	"testing"
	"time"
)

// Task 3.1 — RED: Window is the single shared 30-day recovery constant,
// consumed by both the Trash countdown (purgeAt = deletedAt + Window, in
// organizations.ListDeletedOrganizations and workspaces.ListDeleted) and the
// eventual purge sweep (a later unit, not built here). Pure structural
// check: one constant, no branching, so a single assertion is exhaustive.
// Triangulation skipped: there is only one possible value for a const.
func TestWindowIsThirtyDays(t *testing.T) {
	t.Parallel()

	want := 30 * 24 * time.Hour
	if Window != want {
		t.Fatalf("Window = %v, want %v", Window, want)
	}
}

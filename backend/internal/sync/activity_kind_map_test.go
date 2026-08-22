package syncapi

import (
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
)

// TestActivityKindByEventTypeHasExactlySixEntries is a DB-free pure-logic
// test: activityKindByEventType is the only bridge between sync's wire
// event_type vocabulary and activity's audit Kind vocabulary (design.md
// Decision 1). It must have exactly the 6 entries the 8 mutation call sites
// need — no more, no less, so an unmapped eventType fails closed.
// RED: activityKindByEventType does not exist yet, so this fails to compile.
func TestActivityKindByEventTypeHasExactlySixEntries(t *testing.T) {
	if got, want := len(activityKindByEventType), 6; got != want {
		t.Fatalf("len(activityKindByEventType) = %d, want %d", got, want)
	}
}

// TestActivityKindByEventTypeCoversAllCallSiteLiterals is a table-driven,
// DB-free test asserting every eventType literal used at the 8 call sites in
// postgres.go (6 distinct type+action combinations, since
// ApplyPreparedFolderPatchTx/ApplyPreparedBookmarkPatchTx reuse the
// "folder.updated"/"bookmark.updated" literals) resolves to the matching
// activity.Kind constant.
func TestActivityKindByEventTypeCoversAllCallSiteLiterals(t *testing.T) {
	cases := []struct {
		eventType string
		wantKind  activity.Kind
	}{
		{"folder.created", activity.KindFolderCreated},
		{"folder.updated", activity.KindFolderUpdated},
		{"folder.deleted", activity.KindFolderDeleted},
		{"bookmark.created", activity.KindBookmarkCreated},
		{"bookmark.updated", activity.KindBookmarkUpdated},
		{"bookmark.deleted", activity.KindBookmarkDeleted},
	}

	for _, c := range cases {
		kind, ok := activityKindByEventType[c.eventType]
		if !ok {
			t.Errorf("activityKindByEventType[%q]: missing entry", c.eventType)
			continue
		}
		if kind != c.wantKind {
			t.Errorf("activityKindByEventType[%q] = %q, want %q", c.eventType, kind, c.wantKind)
		}
	}
}

// TestActivityKindByEventTypeRejectsUnknownEventType locks in the fail-closed
// contract: an eventType not present in the map yields ok == false, which
// recordEvent (A2a) will turn into an error before the INSERT.
func TestActivityKindByEventTypeRejectsUnknownEventType(t *testing.T) {
	if _, ok := activityKindByEventType["group.renamed"]; ok {
		t.Fatalf("activityKindByEventType[%q]: want missing, got present", "group.renamed")
	}
}

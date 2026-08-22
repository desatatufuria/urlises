package syncapi

import (
	"reflect"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
)

// TestFolderAuditMetadata is a DB-free pure-logic test: folderAuditMetadata
// projects only the name field into the audit metadata map (design.md
// "Recorded metadata" table), independent of the folder's other fields.
// RED: folderAuditMetadata does not exist yet, so this fails to compile.
func TestFolderAuditMetadata(t *testing.T) {
	folder := bookmarks.Folder{
		ID:          "folder-1",
		WorkspaceID: "workspace-1",
		Name:        "Research",
		Position:    3,
	}

	got := folderAuditMetadata(folder)
	want := map[string]any{"name": "Research"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("folderAuditMetadata(%+v) = %#v, want %#v", folder, got, want)
	}
}

// TestFolderAuditMetadataDifferentName triangulates with a different input to
// prove the "name" field is actually read from the folder, not hardcoded.
func TestFolderAuditMetadataDifferentName(t *testing.T) {
	folder := bookmarks.Folder{ID: "folder-2", Name: "Archive"}

	got := folderAuditMetadata(folder)
	want := map[string]any{"name": "Archive"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("folderAuditMetadata(%+v) = %#v, want %#v", folder, got, want)
	}
}

// TestBookmarkAuditMetadata is a DB-free pure-logic test: bookmarkAuditMetadata
// projects title and url into the audit metadata map (design.md "Recorded
// metadata" table), independent of the bookmark's other fields.
// RED: bookmarkAuditMetadata does not exist yet, so this fails to compile.
func TestBookmarkAuditMetadata(t *testing.T) {
	bookmark := bookmarks.Bookmark{
		ID:          "bookmark-1",
		WorkspaceID: "workspace-1",
		FolderID:    "folder-1",
		Title:       "Go Docs",
		URL:         "https://go.dev",
		Position:    1,
	}

	got := bookmarkAuditMetadata(bookmark)
	want := map[string]any{"title": "Go Docs", "url": "https://go.dev"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bookmarkAuditMetadata(%+v) = %#v, want %#v", bookmark, got, want)
	}
}

// TestBookmarkAuditMetadataDifferentValues triangulates with a different
// input to prove title/url are actually read from the bookmark, not
// hardcoded.
func TestBookmarkAuditMetadataDifferentValues(t *testing.T) {
	bookmark := bookmarks.Bookmark{ID: "bookmark-2", Title: "Rust Book", URL: "https://doc.rust-lang.org/book/"}

	got := bookmarkAuditMetadata(bookmark)
	want := map[string]any{"title": "Rust Book", "url": "https://doc.rust-lang.org/book/"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bookmarkAuditMetadata(%+v) = %#v, want %#v", bookmark, got, want)
	}
}

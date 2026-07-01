package workspaces

import "testing"

func TestBuildFolderTreeBuildsNestedCanonicalTree(t *testing.T) {
	rootA := "root-a"
	rootB := "root-b"

	tree := buildFolderTree(
		[]folderRow{
			{ID: rootA, Name: "Engineering", Position: 0},
			{ID: rootB, Name: "Product", Position: 1},
			{ID: "child-a", ParentID: &rootA, Name: "Backend", Position: 0},
			{ID: "child-b", ParentID: &rootA, Name: "Frontend", Position: 1},
			{ID: "grandchild", ParentID: stringPtr("child-a"), Name: "API", Position: 0},
		},
		[]bookmarkRow{
			{ID: "bookmark-root", FolderID: rootA, Title: "Architecture", URL: "https://example.com/arch", Position: 0},
			{ID: "bookmark-child", FolderID: "child-a", Title: "Backend guide", URL: "https://example.com/backend", Position: 0},
			{ID: "bookmark-grandchild", FolderID: "grandchild", Title: "API docs", URL: "https://example.com/api", Position: 0},
		},
	)

	if len(tree) != 2 {
		t.Fatalf("expected 2 root folders, got %d", len(tree))
	}
	if tree[0].ID != rootA || tree[1].ID != rootB {
		t.Fatalf("expected roots to preserve query order, got %q then %q", tree[0].ID, tree[1].ID)
	}
	if len(tree[0].Bookmarks) != 1 || tree[0].Bookmarks[0].ID != "bookmark-root" {
		t.Fatalf("expected root bookmark to stay attached to %q", rootA)
	}
	if len(tree[0].Folders) != 2 {
		t.Fatalf("expected 2 children under %q, got %d", rootA, len(tree[0].Folders))
	}
	if tree[0].Folders[0].ID != "child-a" || tree[0].Folders[1].ID != "child-b" {
		t.Fatalf("expected child order to preserve query order, got %q then %q", tree[0].Folders[0].ID, tree[0].Folders[1].ID)
	}
	if len(tree[0].Folders[0].Bookmarks) != 1 || tree[0].Folders[0].Bookmarks[0].ID != "bookmark-child" {
		t.Fatalf("expected child bookmark to stay attached to child-a")
	}
	if len(tree[0].Folders[0].Folders) != 1 || tree[0].Folders[0].Folders[0].ID != "grandchild" {
		t.Fatalf("expected grandchild folder to be nested under child-a")
	}
	if len(tree[0].Folders[0].Folders[0].Bookmarks) != 1 || tree[0].Folders[0].Folders[0].Bookmarks[0].ID != "bookmark-grandchild" {
		t.Fatalf("expected grandchild bookmark to stay attached to grandchild")
	}
}

func TestBuildFolderTreeIgnoresBookmarksForUnknownFolders(t *testing.T) {
	tree := buildFolderTree(
		[]folderRow{{ID: "root", Name: "Root", Position: 0}},
		[]bookmarkRow{
			{ID: "kept", FolderID: "root", Title: "Kept", URL: "https://example.com/kept", Position: 0},
			{ID: "orphan", FolderID: "missing", Title: "Orphan", URL: "https://example.com/orphan", Position: 0},
		},
	)

	if len(tree) != 1 {
		t.Fatalf("expected 1 root folder, got %d", len(tree))
	}
	if len(tree[0].Bookmarks) != 1 {
		t.Fatalf("expected only known-folder bookmarks to be attached, got %d", len(tree[0].Bookmarks))
	}
	if tree[0].Bookmarks[0].ID != "kept" {
		t.Fatalf("expected kept bookmark to remain attached, got %q", tree[0].Bookmarks[0].ID)
	}
}

func stringPtr(value string) *string {
	return &value
}

package syncapi

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Work unit A2a — recordEvent SQL restructure + Record() call + the 8 call
// sites. Each of the 6 mutation-type cases below asserts exactly one
// activity_events row lands in the same transaction as the mutation, with
// organization_id resolved by the CTE (never passed in), the real principal
// as actor_user_id, the correct kind/target, and metadata carrying the
// expected entity keys plus workspaceId/workspaceName (design.md Decision 3).

func TestActivityAuditCreateBookmarkRecordsOneEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	result, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{Title: "Design Doc", URL: "https://example.com/design"}, Metadata{
		EventID:        "evt-bookmark-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	records := loadActivityEventRecords(t, ctx, pool, organizationID)
	if len(records) != 1 {
		t.Fatalf("activity_events count = %d, want 1", len(records))
	}
	rec := records[0]
	if rec.OrganizationID != organizationID {
		t.Fatalf("organization id = %q, want %q", rec.OrganizationID, organizationID)
	}
	if rec.ActorUserID != userID {
		t.Fatalf("actor user id = %q, want %q", rec.ActorUserID, userID)
	}
	if rec.Kind != string(activity.KindBookmarkCreated) {
		t.Fatalf("kind = %q, want %q", rec.Kind, activity.KindBookmarkCreated)
	}
	if rec.TargetType != "bookmark" || rec.TargetID != result.Resource.ID {
		t.Fatalf("target = %s/%s, want bookmark/%s", rec.TargetType, rec.TargetID, result.Resource.ID)
	}
	assertBookmarkAuditMetadata(t, rec.Metadata, "Design Doc", "https://example.com/design", workspaceID)
}

func TestActivityAuditUpdateBookmarkRecordsOneEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	created, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{Title: "Original", URL: "https://example.com/original"}, Metadata{
		EventID:        "evt-bookmark-update-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	title := "Renamed"
	url := "https://example.com/renamed"
	if _, err := store.UpdateBookmark(ctx, userID, created.Resource.ID, bookmarks.UpdateBookmarkInput{Title: &title, URL: &url}, Metadata{
		EventID:        "evt-bookmark-update",
		OriginClientID: "client-a",
	}); err != nil {
		t.Fatalf("update bookmark: %v", err)
	}

	records := loadActivityEventRecords(t, ctx, pool, organizationID)
	if len(records) != 2 {
		t.Fatalf("activity_events count = %d, want 2 (create + update)", len(records))
	}
	rec := records[1]
	if rec.Kind != string(activity.KindBookmarkUpdated) {
		t.Fatalf("kind = %q, want %q", rec.Kind, activity.KindBookmarkUpdated)
	}
	if rec.TargetType != "bookmark" || rec.TargetID != created.Resource.ID {
		t.Fatalf("target = %s/%s, want bookmark/%s", rec.TargetType, rec.TargetID, created.Resource.ID)
	}
	assertBookmarkAuditMetadata(t, rec.Metadata, "Renamed", "https://example.com/renamed", workspaceID)
}

func TestActivityAuditDeleteBookmarkRecordsEventWithPreDeleteMetadata(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	created, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{Title: "To Delete", URL: "https://example.com/to-delete"}, Metadata{
		EventID:        "evt-bookmark-delete-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	if _, err := store.DeleteBookmark(ctx, userID, created.Resource.ID, Metadata{
		EventID:        "evt-bookmark-delete",
		OriginClientID: "client-a",
	}); err != nil {
		t.Fatalf("delete bookmark: %v", err)
	}

	records := loadActivityEventRecords(t, ctx, pool, organizationID)
	if len(records) != 2 {
		t.Fatalf("activity_events count = %d, want 2 (create + delete)", len(records))
	}
	rec := records[1]
	if rec.Kind != string(activity.KindBookmarkDeleted) {
		t.Fatalf("kind = %q, want %q", rec.Kind, activity.KindBookmarkDeleted)
	}
	if rec.TargetType != "bookmark" || rec.TargetID != created.Resource.ID {
		t.Fatalf("target = %s/%s, want bookmark/%s", rec.TargetType, rec.TargetID, created.Resource.ID)
	}
	assertBookmarkAuditMetadata(t, rec.Metadata, "To Delete", "https://example.com/to-delete", workspaceID)
}

func TestActivityAuditCreateFolderRecordsOneEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	result, err := store.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Research"}, Metadata{
		EventID:        "evt-folder-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	records := loadActivityEventRecords(t, ctx, pool, organizationID)
	if len(records) != 1 {
		t.Fatalf("activity_events count = %d, want 1", len(records))
	}
	rec := records[0]
	if rec.OrganizationID != organizationID {
		t.Fatalf("organization id = %q, want %q", rec.OrganizationID, organizationID)
	}
	if rec.ActorUserID != userID {
		t.Fatalf("actor user id = %q, want %q", rec.ActorUserID, userID)
	}
	if rec.Kind != string(activity.KindFolderCreated) {
		t.Fatalf("kind = %q, want %q", rec.Kind, activity.KindFolderCreated)
	}
	if rec.TargetType != "folder" || rec.TargetID != result.Resource.ID {
		t.Fatalf("target = %s/%s, want folder/%s", rec.TargetType, rec.TargetID, result.Resource.ID)
	}
	assertFolderAuditMetadata(t, rec.Metadata, "Research", workspaceID)
}

func TestActivityAuditUpdateFolderRecordsOneEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	created, err := store.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Original"}, Metadata{
		EventID:        "evt-folder-update-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	name := "Renamed"
	if _, err := store.UpdateFolder(ctx, userID, created.Resource.ID, bookmarks.UpdateFolderInput{Name: &name}, Metadata{
		EventID:        "evt-folder-update",
		OriginClientID: "client-a",
	}); err != nil {
		t.Fatalf("update folder: %v", err)
	}

	records := loadActivityEventRecords(t, ctx, pool, organizationID)
	if len(records) != 2 {
		t.Fatalf("activity_events count = %d, want 2 (create + update)", len(records))
	}
	rec := records[1]
	if rec.Kind != string(activity.KindFolderUpdated) {
		t.Fatalf("kind = %q, want %q", rec.Kind, activity.KindFolderUpdated)
	}
	if rec.TargetType != "folder" || rec.TargetID != created.Resource.ID {
		t.Fatalf("target = %s/%s, want folder/%s", rec.TargetType, rec.TargetID, created.Resource.ID)
	}
	assertFolderAuditMetadata(t, rec.Metadata, "Renamed", workspaceID)
}

func TestActivityAuditDeleteFolderRecordsEventWithPreDeleteMetadata(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	created, err := store.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "To Delete"}, Metadata{
		EventID:        "evt-folder-delete-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	if _, err := store.DeleteFolder(ctx, userID, created.Resource.ID, Metadata{
		EventID:        "evt-folder-delete",
		OriginClientID: "client-a",
	}); err != nil {
		t.Fatalf("delete folder: %v", err)
	}

	records := loadActivityEventRecords(t, ctx, pool, organizationID)
	if len(records) != 2 {
		t.Fatalf("activity_events count = %d, want 2 (create + delete)", len(records))
	}
	rec := records[1]
	if rec.Kind != string(activity.KindFolderDeleted) {
		t.Fatalf("kind = %q, want %q", rec.Kind, activity.KindFolderDeleted)
	}
	if rec.TargetType != "folder" || rec.TargetID != created.Resource.ID {
		t.Fatalf("target = %s/%s, want folder/%s", rec.TargetType, rec.TargetID, created.Resource.ID)
	}
	assertFolderAuditMetadata(t, rec.Metadata, "To Delete", workspaceID)
}

// TestApplyPreparedFolderPatchNoOpRecordsNoSyncOrActivityEvent locks in that a
// no-op prepared PATCH (design.md's early `patch.NoOp` return) produces zero
// sync_events rows AND zero activity_events rows — not one without the other.
func TestActivityAuditApplyPreparedFolderPatchNoOpRecordsNoSyncOrActivityEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Untouched"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	beforeSync := syncWriteCounts(t, ctx, pool)
	beforeActivity := countActivityEvents(t, ctx, pool, organizationID)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	patch, err := bookmarkService.PrepareFolderPatchTx(ctx, tx, userID, folder.ID, bookmarks.UpdateFolderInput{})
	if err != nil {
		t.Fatalf("prepare folder patch: %v", err)
	}
	result, err := store.ApplyPreparedFolderPatchTx(ctx, tx, userID, patch, Metadata{EventID: "evt-folder-noop", OriginClientID: "client-a"})
	if err != nil {
		t.Fatalf("apply prepared folder patch: %v", err)
	}
	if result.Event != nil || result.PostCommit != nil {
		t.Fatalf("no-op result = %+v, want no event or post-commit work", result)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	if after := syncWriteCounts(t, ctx, pool); after != beforeSync {
		t.Fatalf("sync writes after no-op = %v, want %v", after, beforeSync)
	}
	if after := countActivityEvents(t, ctx, pool, organizationID); after != beforeActivity {
		t.Fatalf("activity_events count after no-op = %d, want %d", after, beforeActivity)
	}
}

// TestRecordEventRejectsUnknownEventTypeAndRollsBackTransaction guards
// Decision 1's fail-closed contract directly at recordEvent (the 8 real call
// sites always pass a valid literal, so this exercises the unmapped-eventType
// path that only a garbage input can reach).
func TestActivityAuditRecordEventRejectsUnknownEventTypeAndRollsBackTransaction(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)

	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, nil, nil, activityService, nil)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}

	_, err = store.recordEvent(ctx, tx, userID, workspaceID, "evt-unknown-type", "client-a", "group.renamed", "group", "some-group-id", map[string]any{}, map[string]any{})
	if err == nil {
		t.Fatal("recordEvent with unmapped eventType: want error, got nil")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback tx: %v", err)
	}

	var syncEventCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE workspace_id = $1`, workspaceID).Scan(&syncEventCount); err != nil {
		t.Fatalf("count sync events: %v", err)
	}
	if syncEventCount != 0 {
		t.Fatalf("sync_events count = %d, want 0", syncEventCount)
	}

	if activityEventCount := countActivityEvents(t, ctx, pool, organizationID); activityEventCount != 0 {
		t.Fatalf("activity_events count = %d, want 0", activityEventCount)
	}

	var cursor int64
	err = pool.QueryRow(ctx, `SELECT current_cursor FROM workspace_cursors WHERE workspace_id = $1`, workspaceID).Scan(&cursor)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("workspace cursor after rollback: err=%v cursor=%d, want no row (rolled back)", err, cursor)
	}
}

// --- test helpers ---

type activityEventRecord struct {
	OrganizationID string
	ActorUserID    string
	Kind           string
	TargetType     string
	TargetID       string
	Metadata       map[string]any
}

func loadActivityEventRecords(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string) []activityEventRecord {
	t.Helper()

	rows, err := pool.Query(ctx, `
		SELECT organization_id, actor_user_id, kind, target_type, target_id, metadata
		FROM activity_events
		WHERE organization_id = $1
		ORDER BY created_at ASC
	`, organizationID)
	if err != nil {
		t.Fatalf("query activity events: %v", err)
	}
	defer rows.Close()

	var records []activityEventRecord
	for rows.Next() {
		var rec activityEventRecord
		var metadataJSON []byte
		if err := rows.Scan(&rec.OrganizationID, &rec.ActorUserID, &rec.Kind, &rec.TargetType, &rec.TargetID, &metadataJSON); err != nil {
			t.Fatalf("scan activity event: %v", err)
		}
		if err := json.Unmarshal(metadataJSON, &rec.Metadata); err != nil {
			t.Fatalf("unmarshal activity metadata: %v", err)
		}
		records = append(records, rec)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate activity events: %v", err)
	}

	return records
}

func countActivityEvents(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string) int {
	t.Helper()

	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activity_events WHERE organization_id = $1`, organizationID).Scan(&count); err != nil {
		t.Fatalf("count activity events: %v", err)
	}

	return count
}

func assertBookmarkAuditMetadata(t *testing.T, metadata map[string]any, wantTitle, wantURL, wantWorkspaceID string) {
	t.Helper()

	if got := metadata["title"]; got != wantTitle {
		t.Fatalf("metadata[title] = %v, want %q", got, wantTitle)
	}
	if got := metadata["url"]; got != wantURL {
		t.Fatalf("metadata[url] = %v, want %q", got, wantURL)
	}
	if got := metadata["workspaceId"]; got != wantWorkspaceID {
		t.Fatalf("metadata[workspaceId] = %v, want %q", got, wantWorkspaceID)
	}
	if got, ok := metadata["workspaceName"]; !ok || got == "" {
		t.Fatalf("metadata[workspaceName] = %v, want non-empty", got)
	}
}

func assertFolderAuditMetadata(t *testing.T, metadata map[string]any, wantName, wantWorkspaceID string) {
	t.Helper()

	if got := metadata["name"]; got != wantName {
		t.Fatalf("metadata[name] = %v, want %q", got, wantName)
	}
	if _, hasURL := metadata["url"]; hasURL {
		t.Fatalf("metadata[url] = %v, want absent for a folder event", metadata["url"])
	}
	if got := metadata["workspaceId"]; got != wantWorkspaceID {
		t.Fatalf("metadata[workspaceId] = %v, want %q", got, wantWorkspaceID)
	}
	if got, ok := metadata["workspaceName"]; !ok || got == "" {
		t.Fatalf("metadata[workspaceName] = %v, want non-empty", got)
	}
}

package syncapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Work unit A2a — recordEvent SQL restructure + Record() call + the 8 call
// sites. Each of the 6 mutation-type cases below asserts exactly one
// activity_events row lands in the same transaction as the mutation, with
// organization_id resolved by the CTE (never passed in), the real principal
// as actor_user_id, the correct kind/target, and metadata carrying the
// expected entity keys plus workspaceId/workspaceName (design.md Decision 3).
//
// Work unit A2b — test-only. It adds no production code: A2a already wired
// retry/dedup and transactional rollback correctly, so these tests are
// characterization/approval tests that lock in guarantees the implementation
// already provides, covering the three distinct dedup mechanisms
// (runMutation's loadDuplicateMutationByWorkspace/ByEntity,
// runDeleteMutation's loadDuplicateDeleteByEntity, and
// httpapi.IdempotencyExecutor.ExecutePrepared's claimReceipt replay), the
// audit-failure-aborts-the-mutation guarantee (only testable because of
// Decision 5's narrow activityRecorder interface), and a regression check
// that recordEvent's CTE restructure never changed the Envelope returned to
// callers.

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

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Create Bookmark Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	result, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Design Doc", URL: "https://example.com/design"}, Metadata{
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

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Update Bookmark Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	created, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Original", URL: "https://example.com/original"}, Metadata{
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

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Delete Bookmark Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	created, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "To Delete", URL: "https://example.com/to-delete"}, Metadata{
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

// TestActivityAuditRetryCreateBookmarkThroughRunMutationDoesNotDoubleRecord
// covers mechanism 1: runMutation's loadDuplicateMutationByWorkspace
// early-return (postgres.go's runMutation, ~:321-325) returns the
// already-committed prior result BEFORE apply — and therefore before
// recordEvent/activity.Record — ever runs again for the same eventID.
func TestActivityAuditRetryCreateBookmarkThroughRunMutationDoesNotDoubleRecord(t *testing.T) {
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

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Retry Create Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	metadata := Metadata{EventID: "evt-bookmark-retry-create", OriginClientID: "client-a"}
	input := bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Retry Me", URL: "https://example.com/retry"}

	first, err := store.CreateBookmark(ctx, userID, workspaceID, input, metadata)
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}
	if first.Duplicate {
		t.Fatalf("first create bookmark: Duplicate = true, want false")
	}

	replay, err := store.CreateBookmark(ctx, userID, workspaceID, input, metadata)
	if err != nil {
		t.Fatalf("replay create bookmark: %v", err)
	}
	if !replay.Duplicate {
		t.Fatalf("replay create bookmark: Duplicate = false, want true (loadDuplicateMutationByWorkspace should short-circuit)")
	}
	if replay.Resource.ID != first.Resource.ID {
		t.Fatalf("replay resource id = %q, want %q (same committed resource)", replay.Resource.ID, first.Resource.ID)
	}

	var syncEventCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE workspace_id = $1 AND event_id = $2`, workspaceID, metadata.EventID).Scan(&syncEventCount); err != nil {
		t.Fatalf("count sync events: %v", err)
	}
	if syncEventCount != 1 {
		t.Fatalf("sync_events count = %d, want 1 (retry must not double-write)", syncEventCount)
	}

	if activityCount := countActivityEvents(t, ctx, pool, organizationID); activityCount != 1 {
		t.Fatalf("activity_events count = %d, want 1 (retry must not double-audit)", activityCount)
	}
}

// TestActivityAuditRetryDeleteBookmarkThroughRunDeleteMutationDoesNotDoubleRecord
// covers mechanism 2: runDeleteMutation's loadDuplicateDeleteByEntity
// early-return, the delete-specific counterpart of mechanism 1.
func TestActivityAuditRetryDeleteBookmarkThroughRunDeleteMutationDoesNotDoubleRecord(t *testing.T) {
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

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Retry Delete Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	created, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Delete Retry Me", URL: "https://example.com/delete-retry"}, Metadata{
		EventID:        "evt-bookmark-retry-delete-create",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	deleteMetadata := Metadata{EventID: "evt-bookmark-retry-delete", OriginClientID: "client-a"}

	first, err := store.DeleteBookmark(ctx, userID, created.Resource.ID, deleteMetadata)
	if err != nil {
		t.Fatalf("delete bookmark: %v", err)
	}
	if first.Duplicate {
		t.Fatalf("first delete bookmark: Duplicate = true, want false")
	}

	replay, err := store.DeleteBookmark(ctx, userID, created.Resource.ID, deleteMetadata)
	if err != nil {
		t.Fatalf("replay delete bookmark: %v", err)
	}
	if !replay.Duplicate {
		t.Fatalf("replay delete bookmark: Duplicate = false, want true (loadDuplicateDeleteByEntity should short-circuit)")
	}

	var syncEventCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE entity_id = $1 AND event_id = $2`, created.Resource.ID, deleteMetadata.EventID).Scan(&syncEventCount); err != nil {
		t.Fatalf("count sync events: %v", err)
	}
	if syncEventCount != 1 {
		t.Fatalf("sync_events count = %d, want 1 (retry must not double-write)", syncEventCount)
	}

	var deleteActivityCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activity_events WHERE organization_id = $1 AND kind = $2 AND target_id = $3`, organizationID, string(activity.KindBookmarkDeleted), created.Resource.ID).Scan(&deleteActivityCount); err != nil {
		t.Fatalf("count delete activity events: %v", err)
	}
	if deleteActivityCount != 1 {
		t.Fatalf("activity_events (bookmark.deleted) count = %d, want 1 (retry must not double-audit)", deleteActivityCount)
	}

	if totalActivityCount := countActivityEvents(t, ctx, pool, organizationID); totalActivityCount != 2 {
		t.Fatalf("activity_events total count = %d, want 2 (one create + one delete, no duplicate)", totalActivityCount)
	}
}

// TestActivityAuditRetryBookmarkPatchThroughIdempotencyExecutorDoesNotDoubleRecord
// covers mechanism 3: httpapi.IdempotencyExecutor.ExecutePrepared's
// claimReceipt replay path (idempotency.go ~:156-161) returns the stored
// response WITHOUT invoking Command — and therefore without invoking
// ApplyPreparedBookmarkPatchTx/recordEvent — a second time. This drives the
// real PATCH /bookmarks/{bookmarkId} route (bookmark_routes.go), the exact
// production code path, rather than reimplementing the prepare/command shape.
func TestActivityAuditRetryBookmarkPatchThroughIdempotencyExecutorDoesNotDoubleRecord(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	organizationID, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Patch Retry Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}
	bookmark, err := bookmarkService.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Original", URL: "https://example.com/original"})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)
	service := NewService(store)
	mux := http.NewServeMux()
	RegisterBookmarkRoutes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID, ClientID: "client-a"})))
		})
	}, service, httpapi.NewIdempotencyExecutor(pool))

	patchRequest := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/bookmarks/"+bookmark.ID, strings.NewReader(`{"title":"Renamed via Patch"}`))
		req.Header.Set(HeaderEventID, "evt-bookmark-patch-retry")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}

	beforeActivity := countActivityEvents(t, ctx, pool, organizationID)

	first := patchRequest()
	if first.Code != http.StatusOK {
		t.Fatalf("first patch status = %d, want %d, body=%s", first.Code, http.StatusOK, first.Body.String())
	}
	afterFirst := countActivityEvents(t, ctx, pool, organizationID)
	if afterFirst != beforeActivity+1 {
		t.Fatalf("activity_events count after first patch = %d, want %d", afterFirst, beforeActivity+1)
	}

	replay := patchRequest()
	if replay.Code != first.Code || replay.Body.String() != first.Body.String() || replay.Header().Get(HeaderDuplicate) != first.Header().Get(HeaderDuplicate) {
		t.Fatalf("replay did not preserve the stored acknowledgement: first=%#v replay=%#v", first, replay)
	}

	afterReplay := countActivityEvents(t, ctx, pool, organizationID)
	if afterReplay != afterFirst {
		t.Fatalf("activity_events count after replay = %d, want %d (ExecutePrepared's claimReceipt replay must not double-audit)", afterReplay, afterFirst)
	}

	var syncEventCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE entity_id = $1 AND event_id = $2`, bookmark.ID, "evt-bookmark-patch-retry").Scan(&syncEventCount); err != nil {
		t.Fatalf("count sync events: %v", err)
	}
	if syncEventCount != 1 {
		t.Fatalf("sync_events count = %d, want 1 (retry must not double-write)", syncEventCount)
	}
}

// failingActivityRecorder is an activityRecorder stub whose Record always
// fails, only constructible because design.md Decision 5 made
// PostgresStore.activity a narrow injectable interface instead of a concrete
// *activity.Service dependency. It is the only way to test that an audit
// failure aborts the WHOLE mutation transaction, not just the audit write.
type failingActivityRecorder struct{}

func (failingActivityRecorder) Record(ctx context.Context, tx pgx.Tx, orgID, actorUserID string, kind activity.Kind, targetType, targetID string, metadata map[string]any) error {
	return errors.New("boom")
}

// TestActivityAuditFailureAbortsCreateBookmarkMutationTransaction proves the
// proposal's "audit is transactional, not best-effort" claim actually holds:
// when activity.Record fails, recordEvent returns an error which propagates
// out of the apply closure, so runMutation's deferred tx.Rollback(ctx) undoes
// everything — the bookmark row, the sync_events row, and the
// workspace_cursors bump — not just the activity_events insert.
func TestActivityAuditFailureAbortsCreateBookmarkMutationTransaction(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	_, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	store := NewPostgresStore(pool, bookmarkService, nil, failingActivityRecorder{}, nil)

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Aborted Mutation Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	_, err = store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Should Not Persist", URL: "https://example.com/aborted"}, Metadata{
		EventID:        "evt-bookmark-audit-failure",
		OriginClientID: "client-a",
	})
	if err == nil {
		t.Fatal("create bookmark with failing activity recorder: want error, got nil")
	}

	var bookmarkCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM bookmarks WHERE workspace_id = $1`, workspaceID).Scan(&bookmarkCount); err != nil {
		t.Fatalf("count bookmarks: %v", err)
	}
	if bookmarkCount != 0 {
		t.Fatalf("bookmarks count = %d, want 0 (whole transaction must roll back, not just the audit write)", bookmarkCount)
	}

	var syncEventCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE workspace_id = $1`, workspaceID).Scan(&syncEventCount); err != nil {
		t.Fatalf("count sync events: %v", err)
	}
	if syncEventCount != 0 {
		t.Fatalf("sync_events count = %d, want 0 (whole transaction must roll back)", syncEventCount)
	}

	var cursor int64
	err = pool.QueryRow(ctx, `SELECT current_cursor FROM workspace_cursors WHERE workspace_id = $1`, workspaceID).Scan(&cursor)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("workspace cursor after audit failure: err=%v cursor=%d, want no row (rolled back, no cursor bump)", err, cursor)
	}
}

// TestActivityAuditCreateBookmarkReturnsEnvelopeWithUnchangedFields is the
// regression lock for Success Criterion 5: the recordEvent CTE restructure
// added two NEW local scan targets (organizationID, workspaceName) that feed
// ONLY the audit metadata. This asserts the returned Envelope's fields are
// exactly what the pre-restructure code would have produced, and that
// neither new scan target leaked onto the Envelope or the sync payload.
func TestActivityAuditCreateBookmarkReturnsEnvelopeWithUnchangedFields(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	_, workspaceID := insertSyncTestOrganizationAndWorkspace(t, ctx, pool)
	userID := insertSyncTestUser(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	activityService := activity.NewService(pool)
	store := NewPostgresStore(pool, bookmarkService, nil, activityService, nil)

	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Envelope Check Folder"})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	result, err := store.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Envelope Check", URL: "https://example.com/envelope"}, Metadata{
		EventID:        "evt-envelope-fields",
		OriginClientID: "client-envelope",
	})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}

	envelope := result.Event
	if envelope.Cursor != 1 {
		t.Fatalf("envelope.Cursor = %d, want 1", envelope.Cursor)
	}
	if envelope.EventID != "evt-envelope-fields" {
		t.Fatalf("envelope.EventID = %q, want %q", envelope.EventID, "evt-envelope-fields")
	}
	if envelope.WorkspaceID != workspaceID {
		t.Fatalf("envelope.WorkspaceID = %q, want %q", envelope.WorkspaceID, workspaceID)
	}
	if envelope.OriginClientID != "client-envelope" {
		t.Fatalf("envelope.OriginClientID = %q, want %q", envelope.OriginClientID, "client-envelope")
	}
	if envelope.Kind != "bookmark.created" {
		t.Fatalf("envelope.Kind = %q, want %q", envelope.Kind, "bookmark.created")
	}
	if envelope.EntityType != "bookmark" {
		t.Fatalf("envelope.EntityType = %q, want %q", envelope.EntityType, "bookmark")
	}
	if envelope.EntityID != result.Resource.ID {
		t.Fatalf("envelope.EntityID = %q, want %q", envelope.EntityID, result.Resource.ID)
	}
	if envelope.CreatedAt == "" {
		t.Fatal("envelope.CreatedAt = \"\", want non-empty RFC3339 timestamp")
	}

	var payload map[string]any
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		t.Fatalf("unmarshal envelope payload: %v", err)
	}
	if payload["title"] != "Envelope Check" || payload["url"] != "https://example.com/envelope" {
		t.Fatalf("envelope payload = %v, want title/url matching the create input", payload)
	}
	if _, hasWorkspaceName := payload["workspaceName"]; hasWorkspaceName {
		t.Fatalf("envelope payload = %v, must never carry the audit-only workspaceName scan target", payload)
	}
	if _, hasOrganizationID := payload["organizationId"]; hasOrganizationID {
		t.Fatalf("envelope payload = %v, must never carry the audit-only organizationId scan target", payload)
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

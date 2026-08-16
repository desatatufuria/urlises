package syncapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/jackc/pgx/v5/pgxpool"
)

func openSyncTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("SYNC_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set SYNC_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("sync_scope_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schema)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schema)); admin.Close() })
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(ctx, pool, filepath.Clean(filepath.Join("..", "..", "migrations"))); err != nil {
		t.Fatal(err)
	}
	return ctx, pool
}

func syncWriteCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool) [4]int {
	t.Helper()
	var counts [4]int
	for i, table := range []string{"folders", "bookmarks", "sync_events", "workspace_cursors"} {
		if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM "+table).Scan(&counts[i]); err != nil {
			t.Fatal(err)
		}
	}
	return counts
}

func TestCreateFolderCreatesCursorAndSyncEventWhenWorkspaceCursorRowDoesNotExist(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("SYNC_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set SYNC_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests")
	}

	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	defer adminPool.Close()
	if err := adminPool.Ping(ctx); err != nil {
		t.Skipf("skipping PostgreSQL integration test: %v", err)
	}

	schemaName := fmt.Sprintf("sync_test_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schemaName)); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	defer func() {
		if _, err := adminPool.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schemaName)); err != nil {
			t.Fatalf("drop schema: %v", err)
		}
	}()

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database url: %v", err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open test pool: %v", err)
	}
	defer pool.Close()

	if err := database.Migrate(ctx, pool, filepath.Clean(filepath.Join("..", "..", "migrations"))); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}

	userID := insertSyncTestUser(t, ctx, pool)
	workspaceID := insertSyncTestWorkspace(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")

	store := NewPostgresStore(pool, bookmarks.NewService(pool, access.NewService(pool)), nil, nil)
	result, err := store.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "First sync folder"}, Metadata{
		EventID:        "evt-first-folder",
		OriginClientID: "client-a",
	})
	if err != nil {
		t.Fatalf("create folder via sync store: %v", err)
	}
	if result.Event.Cursor != 1 {
		t.Fatalf("event cursor = %d, want 1", result.Event.Cursor)
	}

	currentCursor, err := store.CurrentCursor(ctx, workspaceID)
	if err != nil {
		t.Fatalf("load current cursor: %v", err)
	}
	if currentCursor != 1 {
		t.Fatalf("current cursor = %d, want 1", currentCursor)
	}

	storedEvent := loadSyncEventRecord(t, ctx, pool, workspaceID)
	if storedEvent.EventID != "evt-first-folder" {
		t.Fatalf("stored event id = %q, want evt-first-folder", storedEvent.EventID)
	}
	if storedEvent.Cursor != 1 {
		t.Fatalf("stored event cursor = %d, want 1", storedEvent.Cursor)
	}
	if storedEvent.EventType != "folder.created" {
		t.Fatalf("stored event type = %q, want folder.created", storedEvent.EventType)
	}
	if storedEvent.EntityID != result.Resource.ID {
		t.Fatalf("stored entity id = %q, want %q", storedEvent.EntityID, result.Resource.ID)
	}
	if storedEvent.OrganizationID == "" {
		t.Fatal("stored organization id should not be empty")
	}
	if storedEvent.DeviceID != nil {
		t.Fatalf("stored device id = %v, want nil when the client device is not registered", *storedEvent.DeviceID)
	}
	if storedEvent.OriginClientID != "client-a" {
		t.Fatalf("stored origin client id = %q, want client-a", storedEvent.OriginClientID)
	}
}

func TestApplyPreparedPatchesTxRecordsOnlyMutationsAndReturnsPostCommit(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	userID := insertSyncTestUser(t, ctx, pool)
	workspaceID := insertSyncTestWorkspace(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")
	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	source, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Source"})
	if err != nil {
		t.Fatal(err)
	}
	target, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Original", ParentID: &source.ID})
	if err != nil {
		t.Fatal(err)
	}
	bookmark, err := bookmarkService.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: source.ID, Title: "Original", URL: "https://example.com/original"})
	if err != nil {
		t.Fatal(err)
	}
	publisher := &recordingPublisher{pool: pool}
	store := NewPostgresStore(pool, bookmarkService, nil, publisher)

	before := syncWriteCounts(t, ctx, pool)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	noOp, err := bookmarkService.PrepareFolderPatchTx(ctx, tx, userID, folder.ID, bookmarks.UpdateFolderInput{})
	if err != nil {
		t.Fatal(err)
	}
	noOpResult, err := store.ApplyPreparedFolderPatchTx(ctx, tx, userID, noOp, Metadata{EventID: "event-no-op", OriginClientID: "client-a"})
	if err != nil {
		t.Fatal(err)
	}
	if noOpResult.Event != nil || noOpResult.PostCommit != nil || noOpResult.Resource.ID != noOp.Final.ID || noOpResult.Resource.Name != noOp.Final.Name || noOpResult.Resource.Position != noOp.Final.Position {
		t.Fatalf("no-op result = %+v, want prepared resource without event or post-commit work", noOpResult)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if after := syncWriteCounts(t, ctx, pool); after != before {
		t.Fatalf("no-op writes = %v, want %v", after, before)
	}

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	position := 0
	title := "Renamed"
	patch, err := bookmarkService.PrepareBookmarkPatchTx(ctx, tx, userID, bookmark.ID, bookmarks.UpdateBookmarkInput{
		FolderID: bookmarks.OptionalString{Set: true, Value: &target.ID},
		Title:    &title,
		Position: bookmarks.OptionalInt{Set: true, Value: position},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.ApplyPreparedBookmarkPatchTx(ctx, tx, userID, patch, Metadata{EventID: "event-bookmark", OriginClientID: "client-a"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Resource.ID != patch.Final.ID || result.Resource.FolderID != patch.Final.FolderID || result.Resource.Title != patch.Final.Title || result.Resource.URL != patch.Final.URL || result.Resource.Position != patch.Final.Position || result.Event == nil || result.Event.EventID != "event-bookmark" || result.Event.Cursor != 1 {
		t.Fatalf("mutation result = %+v, want exact prepared resource and event cursor 1", result)
	}
	if result.PostCommit == nil || result.PostCommit.Event.EventID != result.Event.EventID || result.PostCommit.Event.Cursor != result.Event.Cursor || result.PostCommit.Publisher != publisher || publisher.calls != 0 {
		t.Fatalf("post-commit result = %+v, publisher calls = %d, want returned-only publisher data", result.PostCommit, publisher.calls)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if after := syncWriteCounts(t, ctx, pool); after != [4]int{before[0], before[1], before[2] + 1, before[3] + 1} {
		t.Fatalf("mutation writes = %v, want one event and cursor", after)
	}

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackTitle := "Rolled back"
	rollbackPatch, err := bookmarkService.PrepareBookmarkPatchTx(ctx, tx, userID, bookmark.ID, bookmarks.UpdateBookmarkInput{Title: &rollbackTitle})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyPreparedBookmarkPatchTx(ctx, tx, userID, rollbackPatch, Metadata{EventID: "event-rollback", OriginClientID: "client-a"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if after := syncWriteCounts(t, ctx, pool); after != [4]int{before[0], before[1], before[2] + 1, before[3] + 1} {
		t.Fatalf("rollback writes = %v, want committed mutation only", after)
	}

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := bookmarkService.UpdateFolderTx(ctx, tx, userID, folder.ID, bookmarks.UpdateFolderInput{Name: &title})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.Name != title {
		t.Fatalf("legacy UpdateFolderTx name = %q, want %q", legacy.Name, title)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFolderPatchRouteExecutesPreparedTransaction(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	userID := insertSyncTestUser(t, ctx, pool)
	workspaceID := insertSyncTestWorkspace(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")
	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Original"})
	if err != nil {
		t.Fatal(err)
	}
	publisher := &recordingPublisher{pool: pool}
	service := NewService(NewPostgresStore(pool, bookmarkService, nil, publisher))
	mux := http.NewServeMux()
	RegisterBookmarkRoutes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID, ClientID: "client-a"})))
		})
	}, service, httpapi.NewIdempotencyExecutor(pool))
	request := func(key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/folders/"+folder.ID, strings.NewReader(body))
		req.Header.Set(HeaderEventID, key)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}

	first := request("folder-change", `{"name":" Renamed "}`)
	if first.Code != http.StatusOK || first.Header().Get(HeaderEventID) != "folder-change" || first.Header().Get(HeaderCursor) != "1" || first.Header().Get(HeaderDuplicate) != "false" || publisher.calls != 1 || publisher.eventCount != 1 {
		t.Fatalf("first response = status %d headers %#v publishes %d event %q count %d", first.Code, first.Header(), publisher.calls, publisher.eventID, publisher.eventCount)
	}
	replay := request("folder-change", `{"name":" Renamed "}`)
	if replay.Code != first.Code || replay.Body.String() != first.Body.String() || replay.Header().Get(HeaderEventID) != first.Header().Get(HeaderEventID) || replay.Header().Get(HeaderCursor) != first.Header().Get(HeaderCursor) || replay.Header().Get(HeaderDuplicate) != first.Header().Get(HeaderDuplicate) || publisher.calls != 1 {
		t.Fatalf("replay did not preserve the stored acknowledgement: %#v", replay)
	}
	if conflict := request("folder-change", `{"name":"Different"}`); conflict.Code != http.StatusBadRequest || publisher.calls != 1 {
		t.Fatalf("conflict = status %d publishes %d", conflict.Code, publisher.calls)
	}

	before := syncWriteCounts(t, ctx, pool)
	noOp := request("folder-no-op", `{}`)
	noOpReplay := request("folder-no-op", `{}`)
	if noOp.Code != http.StatusOK || noOpReplay.Code != noOp.Code || noOpReplay.Body.String() != noOp.Body.String() || noOpReplay.Header().Get(HeaderCursor) != noOp.Header().Get(HeaderCursor) || syncWriteCounts(t, ctx, pool) != before || publisher.calls != 1 {
		t.Fatalf("no-op/replay changed state or acknowledgement: no-op=%#v replay=%#v", noOp, noOpReplay)
	}
	if rejected := request("folder-contained", fmt.Sprintf(`{"parentId":%q}`, folder.ID)); rejected.Code != http.StatusBadRequest || syncWriteCounts(t, ctx, pool) != before {
		t.Fatalf("containment rejection = status %d", rejected.Code)
	}
	badCursor := httptest.NewRequest(http.MethodPatch, "/folders/"+folder.ID, strings.NewReader(`{}`))
	badCursor.Header.Set(HeaderEventID, "folder-bad-cursor")
	badCursor.Header.Set(HeaderBaseCursor, "not-a-cursor")
	badCursorResult := httptest.NewRecorder()
	mux.ServeHTTP(badCursorResult, badCursor)
	if badCursorResult.Code != http.StatusBadRequest || syncWriteCounts(t, ctx, pool) != before {
		t.Fatalf("base cursor rejection = status %d", badCursorResult.Code)
	}
	forbiddenMux := http.NewServeMux()
	RegisterBookmarkRoutes(forbiddenMux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "00000000-0000-0000-0000-000000000000", ClientID: "client-b"})))
		})
	}, service, httpapi.NewIdempotencyExecutor(pool))
	forbidden := httptest.NewRequest(http.MethodPatch, "/folders/"+folder.ID, strings.NewReader(`{"name":"Denied"}`))
	forbidden.Header.Set(HeaderEventID, "folder-forbidden")
	forbiddenResult := httptest.NewRecorder()
	forbiddenMux.ServeHTTP(forbiddenResult, forbidden)
	if forbiddenResult.Code != http.StatusForbidden || syncWriteCounts(t, ctx, pool) != before {
		t.Fatalf("forbidden rejection = status %d body %s", forbiddenResult.Code, forbiddenResult.Body.String())
	}
}

func TestBookmarkPatchRouteExecutesPreparedTransaction(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	userID := insertSyncTestUser(t, ctx, pool)
	workspaceID := insertSyncTestWorkspace(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, workspaceID, userID, "editor")
	bookmarkService := bookmarks.NewService(pool, access.NewService(pool))
	folder, err := bookmarkService.CreateFolder(ctx, userID, workspaceID, bookmarks.CreateFolderInput{Name: "Bookmarks"})
	if err != nil {
		t.Fatal(err)
	}
	bookmark, err := bookmarkService.CreateBookmark(ctx, userID, workspaceID, bookmarks.CreateBookmarkInput{FolderID: folder.ID, Title: "Original", URL: "https://example.com/original"})
	if err != nil {
		t.Fatal(err)
	}
	foreignWorkspaceID := insertSyncTestWorkspace(t, ctx, pool)
	insertSyncWorkspaceAccess(t, ctx, pool, foreignWorkspaceID, userID, "editor")
	foreignFolder, err := bookmarkService.CreateFolder(ctx, userID, foreignWorkspaceID, bookmarks.CreateFolderInput{Name: "Foreign"})
	if err != nil {
		t.Fatal(err)
	}
	publisher := &recordingPublisher{pool: pool}
	service := NewService(NewPostgresStore(pool, bookmarkService, nil, publisher))
	mux := http.NewServeMux()
	RegisterBookmarkRoutes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID, ClientID: "client-a"})))
		})
	}, service, httpapi.NewIdempotencyExecutor(pool))
	request := func(key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/bookmarks/"+bookmark.ID, strings.NewReader(body))
		req.Header.Set(HeaderEventID, key)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		return res
	}

	first := request("bookmark-change", `{"title":" Renamed ","url":" https://example.com/renamed "}`)
	if first.Code != http.StatusOK || first.Header().Get(HeaderEventID) != "bookmark-change" || first.Header().Get(HeaderCursor) != "1" || first.Header().Get(HeaderDuplicate) != "false" || publisher.calls != 1 || publisher.eventCount != 1 {
		t.Fatalf("first response = status %d headers %#v publishes %d event %q count %d", first.Code, first.Header(), publisher.calls, publisher.eventID, publisher.eventCount)
	}
	firstBody := first.Body.String()
	var normalized bookmarks.Bookmark
	if err := json.NewDecoder(strings.NewReader(firstBody)).Decode(&normalized); err != nil {
		t.Fatal(err)
	}
	if normalized.Title != "Renamed" || normalized.URL != "https://example.com/renamed" {
		t.Fatalf("normalized bookmark = %+v", normalized)
	}
	replay := request("bookmark-change", `{"title":" Renamed ","url":" https://example.com/renamed "}`)
	if replay.Code != first.Code || replay.Body.String() != firstBody || replay.Header().Get(HeaderEventID) != first.Header().Get(HeaderEventID) || replay.Header().Get(HeaderCursor) != first.Header().Get(HeaderCursor) || replay.Header().Get(HeaderDuplicate) != first.Header().Get(HeaderDuplicate) || publisher.calls != 1 {
		t.Fatalf("replay did not preserve the stored acknowledgement: %#v", replay)
	}
	if conflict := request("bookmark-change", `{"title":"Different"}`); conflict.Code != http.StatusBadRequest || publisher.calls != 1 {
		t.Fatalf("conflict = status %d publishes %d", conflict.Code, publisher.calls)
	}

	before := syncWriteCounts(t, ctx, pool)
	noOp := request("bookmark-no-op", `{}`)
	noOpReplay := request("bookmark-no-op", `{}`)
	if noOp.Code != http.StatusOK || noOpReplay.Code != noOp.Code || noOpReplay.Body.String() != noOp.Body.String() || noOpReplay.Header().Get(HeaderCursor) != noOp.Header().Get(HeaderCursor) || syncWriteCounts(t, ctx, pool) != before || publisher.calls != 1 {
		t.Fatalf("no-op/replay changed state or acknowledgement: no-op=%#v replay=%#v", noOp, noOpReplay)
	}
	if rejected := request("bookmark-contained", fmt.Sprintf(`{"folderId":%q}`, foreignFolder.ID)); rejected.Code != http.StatusNotFound || syncWriteCounts(t, ctx, pool) != before {
		t.Fatalf("containment rejection = status %d", rejected.Code)
	}
	badCursor := httptest.NewRequest(http.MethodPatch, "/bookmarks/"+bookmark.ID, strings.NewReader(`{}`))
	badCursor.Header.Set(HeaderEventID, "bookmark-bad-cursor")
	badCursor.Header.Set(HeaderBaseCursor, "not-a-cursor")
	badCursorResult := httptest.NewRecorder()
	mux.ServeHTTP(badCursorResult, badCursor)
	if badCursorResult.Code != http.StatusBadRequest || syncWriteCounts(t, ctx, pool) != before {
		t.Fatalf("base cursor rejection = status %d", badCursorResult.Code)
	}
	forbiddenMux := http.NewServeMux()
	RegisterBookmarkRoutes(forbiddenMux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "00000000-0000-0000-0000-000000000000", ClientID: "client-b"})))
		})
	}, service, httpapi.NewIdempotencyExecutor(pool))
	forbidden := httptest.NewRequest(http.MethodPatch, "/bookmarks/"+bookmark.ID, strings.NewReader(`{"title":"Denied"}`))
	forbidden.Header.Set(HeaderEventID, "bookmark-forbidden")
	forbiddenResult := httptest.NewRecorder()
	forbiddenMux.ServeHTTP(forbiddenResult, forbidden)
	if forbiddenResult.Code != http.StatusForbidden || syncWriteCounts(t, ctx, pool) != before {
		t.Fatalf("forbidden rejection = status %d body %s", forbiddenResult.Code, forbiddenResult.Body.String())
	}
}

type recordingPublisher struct {
	calls      int
	pool       *pgxpool.Pool
	eventCount int
	eventID    string
}

func (p *recordingPublisher) Publish(ctx context.Context, event Envelope) error {
	p.calls++
	p.eventID = event.EventID
	if p.pool != nil {
		var count int
		if err := p.pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE event_id = $1`, event.EventID).Scan(&count); err != nil {
			return err
		}
		p.eventCount = count
	}
	return nil
}

type syncEventRecord struct {
	EventID        string
	OrganizationID string
	OriginClientID string
	EventType      string
	EntityID       string
	Cursor         int64
	DeviceID       *string
}

func insertSyncTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()

	var userID string
	err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, fmt.Sprintf("sync-tester-%d@example.com", time.Now().UnixNano()), "hash").Scan(&userID)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	return userID
}

func insertSyncTestWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()

	var organizationID string
	err := pool.QueryRow(ctx, `
		INSERT INTO organizations (name)
		VALUES ($1)
		RETURNING id
	`, "Sync Test Org").Scan(&organizationID)
	if err != nil {
		t.Fatalf("insert organization: %v", err)
	}

	var workspaceID string
	err = pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, $3)
		RETURNING id
	`, organizationID, "Sync Test Workspace", "shared").Scan(&workspaceID)
	if err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	return workspaceID
}

func insertSyncWorkspaceAccess(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_user_access (workspace_id, user_id, role)
		VALUES ($1, $2, $3)
	`, workspaceID, userID, role); err != nil {
		t.Fatalf("insert workspace access: %v", err)
	}
}

func loadSyncEventRecord(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string) syncEventRecord {
	t.Helper()

	var event syncEventRecord
	err := pool.QueryRow(ctx, `
		SELECT event_id, organization_id, origin_client_id, event_type, entity_id, cursor, device_id
		FROM sync_events
		WHERE workspace_id = $1
	`, workspaceID).Scan(
		&event.EventID,
		&event.OrganizationID,
		&event.OriginClientID,
		&event.EventType,
		&event.EntityID,
		&event.Cursor,
		&event.DeviceID,
	)
	if err != nil {
		t.Fatalf("load sync event: %v", err)
	}

	return event
}

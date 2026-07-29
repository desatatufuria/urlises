package syncapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPrepareScopesTxSerializesAndRefusesDrift(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openSyncTestPool(t)
	keys := []siblingScopeKey{
		{kind: "bookmark", workspaceID: "workspace", parentID: "destination"},
		{kind: "bookmark", workspaceID: "workspace", parentID: "source"},
	}
	before := syncWriteCounts(t, ctx, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepareScopesTx(ctx, tx, keys, func() error { _, err := tx.Exec(ctx, `SELECT 1 FROM schema_migrations LIMIT 1 FOR UPDATE`); return err }, func() ([]siblingScopeKey, error) { return keys, nil }); err != nil {
		t.Fatal(err)
	}
	blocked := make(chan error, 1)
	go func() {
		other, err := pool.Begin(ctx)
		if err != nil {
			blocked <- err
			return
		}
		defer other.Rollback(ctx)
		blocked <- prepareScopesTx(ctx, other, []siblingScopeKey{keys[1], keys[0], keys[0]}, func() error {
			_, err := other.Exec(ctx, `SELECT 1 FROM schema_migrations LIMIT 1 FOR UPDATE`)
			return err
		}, func() ([]siblingScopeKey, error) { return keys, nil })
	}()
	select {
	case err := <-blocked:
		t.Fatalf("same/opposite scopes did not block: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-blocked:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("scope lock did not release")
	}

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = prepareScopesTx(ctx, tx, keys, func() error { _, err := tx.Exec(ctx, `SELECT 1 FROM schema_migrations LIMIT 1 FOR UPDATE`); return err }, func() ([]siblingScopeKey, error) {
		return []siblingScopeKey{{kind: "bookmark", workspaceID: "workspace", parentID: "changed"}}, nil
	})
	if !IsRetryablePrepareError(err) {
		t.Fatalf("drift error = %v, want retryable", err)
	}
	var drift *PrepareScopeDriftError
	if !errors.As(err, &drift) {
		t.Fatalf("drift error type = %T", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if after := syncWriteCounts(t, ctx, pool); after != before {
		t.Fatalf("prepare writes = %v, want %v", after, before)
	}
}

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

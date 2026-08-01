package bookmarks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPrepareScopesTxSerializesAndRefusesDrift(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}
	ctx, pool := openBookmarksScopeTestPool(t)
	keys := []siblingScopeKey{
		{kind: "bookmark", workspaceID: "workspace", parentID: "destination"},
		{kind: "bookmark", workspaceID: "workspace", parentID: "source"},
	}
	before := bookmarksScopeWriteCounts(t, ctx, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepareScopesTx(ctx, tx, keys, func() error {
		_, err := tx.Exec(ctx, `SELECT 1 FROM schema_migrations LIMIT 1 FOR UPDATE`)
		return err
	}, func() ([]siblingScopeKey, error) { return keys, nil }); err != nil {
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
	err = prepareScopesTx(ctx, tx, keys, func() error {
		_, err := tx.Exec(ctx, `SELECT 1 FROM schema_migrations LIMIT 1 FOR UPDATE`)
		return err
	}, func() ([]siblingScopeKey, error) {
		return []siblingScopeKey{{kind: "bookmark", workspaceID: "workspace", parentID: "changed"}}, nil
	})
	if !isRetryablePrepareError(err) {
		t.Fatalf("drift error = %v, want retryable", err)
	}
	var drift *prepareScopeDriftError
	if !errors.As(err, &drift) {
		t.Fatalf("drift error type = %T", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if after := bookmarksScopeWriteCounts(t, ctx, pool); after != before {
		t.Fatalf("prepare writes = %v, want %v", after, before)
	}
}

func openBookmarksScopeTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("BOOKMARKS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set BOOKMARKS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("bookmarks_scope_test_%d", time.Now().UnixNano())
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

func bookmarksScopeWriteCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool) [4]int {
	t.Helper()
	var counts [4]int
	for i, table := range []string{"folders", "bookmarks", "sync_events", "workspace_cursors"} {
		if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM "+table).Scan(&counts[i]); err != nil {
			t.Fatal(err)
		}
	}
	return counts
}

func TestCreateFolderReordersRootSiblingsInPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("BOOKMARKS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set BOOKMARKS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests")
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

	schemaName := fmt.Sprintf("bookmarks_test_%d", time.Now().UnixNano())
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

	userID := insertTestUser(t, ctx, pool)
	_, workspaceID := insertTestWorkspace(t, ctx, pool)
	insertWorkspaceUserAccess(t, ctx, pool, workspaceID, userID, "editor")
	existingFolderID := insertTestFolder(t, ctx, pool, workspaceID, nil, "Existing", 0)

	service := NewService(pool, nil)
	position := 0
	folder, err := service.CreateFolder(ctx, userID, workspaceID, CreateFolderInput{
		Name:     "Inserted first",
		Position: &position,
	})
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}
	if folder.Position != 0 {
		t.Fatalf("expected new folder position 0, got %d", folder.Position)
	}

	positions := loadFolderPositions(t, ctx, pool, workspaceID)
	if got := positions[folder.ID]; got != 0 {
		t.Fatalf("expected persisted position 0 for new folder, got %d", got)
	}
	if got := positions[existingFolderID]; got != 1 {
		t.Fatalf("expected existing folder to move to position 1, got %d", got)
	}
	if len(positions) != 2 {
		t.Fatalf("expected 2 root folders, got %d", len(positions))
	}
}

func TestCreateBookmarkReordersFolderSiblingsInPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("BOOKMARKS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set BOOKMARKS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests")
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

	schemaName := fmt.Sprintf("bookmarks_test_%d", time.Now().UnixNano())
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

	userID := insertTestUser(t, ctx, pool)
	_, workspaceID := insertTestWorkspace(t, ctx, pool)
	insertWorkspaceUserAccess(t, ctx, pool, workspaceID, userID, "editor")
	folderID := insertTestFolder(t, ctx, pool, workspaceID, nil, "Folder", 0)
	existingBookmarkID := insertTestBookmark(t, ctx, pool, workspaceID, folderID, "Existing", "https://example.com/existing", 0)

	service := NewService(pool, nil)
	position := 0
	bookmark, err := service.CreateBookmark(ctx, userID, workspaceID, CreateBookmarkInput{
		FolderID: folderID,
		Title:    "Inserted first",
		URL:      "https://example.com/inserted",
		Position: &position,
	})
	if err != nil {
		t.Fatalf("create bookmark: %v", err)
	}
	if bookmark.Position != 0 {
		t.Fatalf("expected new bookmark position 0, got %d", bookmark.Position)
	}

	positions := loadBookmarkPositions(t, ctx, pool, workspaceID, folderID)
	if got := positions[bookmark.ID]; got != 0 {
		t.Fatalf("expected persisted position 0 for new bookmark, got %d", got)
	}
	if got := positions[existingBookmarkID]; got != 1 {
		t.Fatalf("expected existing bookmark to move to position 1, got %d", got)
	}
	if len(positions) != 2 {
		t.Fatalf("expected 2 bookmarks in folder, got %d", len(positions))
	}
}

func TestCreateFolderUsesEffectiveSharedAccessResults(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("BOOKMARKS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set BOOKMARKS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests")
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

	schemaName := fmt.Sprintf("bookmarks_test_%d", time.Now().UnixNano())
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

	userID := insertTestUser(t, ctx, pool)
	organizationID, workspaceID := insertTestWorkspace(t, ctx, pool)
	insertOrganizationMember(t, ctx, pool, organizationID, userID, "member")
	insertWorkspaceUserAccess(t, ctx, pool, workspaceID, userID, "viewer")
	groupID := insertTestGroup(t, ctx, pool, organizationID, "monitoring")
	insertTestGroupMember(t, ctx, pool, groupID, userID)
	insertWorkspaceGroupAccess(t, ctx, pool, workspaceID, groupID, "editor")

	service := NewService(pool, nil)
	folder, err := service.CreateFolder(ctx, userID, workspaceID, CreateFolderInput{Name: "Granted by group"})
	if err != nil {
		t.Fatalf("create folder through effective editor access: %v", err)
	}
	if folder.Name != "Granted by group" {
		t.Fatalf("folder name = %q, want Granted by group", folder.Name)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM workspace_group_access WHERE workspace_id = $1 AND group_id = $2`, workspaceID, groupID); err != nil {
		t.Fatalf("delete workspace group access: %v", err)
	}

	_, err = service.CreateFolder(ctx, userID, workspaceID, CreateFolderInput{Name: "Viewer cannot write"})
	if err == nil {
		t.Fatal("expected viewer-only access to reject folder creation")
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM workspace_user_access WHERE workspace_id = $1 AND user_id = $2`, workspaceID, userID); err != nil {
		t.Fatalf("delete workspace user access: %v", err)
	}

	_, err = service.CreateFolder(ctx, userID, workspaceID, CreateFolderInput{Name: "No grants"})
	if err == nil {
		t.Fatal("expected no shared access to reject folder creation")
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

func insertTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()

	var userID string
	err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, fmt.Sprintf("tester-%d@example.com", time.Now().UnixNano()), "hash").Scan(&userID)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	return userID
}

func insertTestWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (string, string) {
	t.Helper()

	var organizationID string
	err := pool.QueryRow(ctx, `
		INSERT INTO organizations (name)
		VALUES ($1)
		RETURNING id
	`, "Test Org").Scan(&organizationID)
	if err != nil {
		t.Fatalf("insert organization: %v", err)
	}

	var workspaceID string
	err = pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, $3)
		RETURNING id
	`, organizationID, "Test Workspace", "shared").Scan(&workspaceID)
	if err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	return organizationID, workspaceID
}

func insertWorkspaceUserAccess(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_user_access (workspace_id, user_id, role)
		VALUES ($1, $2, $3)
	`, workspaceID, userID, role); err != nil {
		t.Fatalf("insert workspace user access: %v", err)
	}
}

func insertOrganizationMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func insertTestGroup(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, name string) string {
	t.Helper()

	var groupID string
	err := pool.QueryRow(ctx, `
		INSERT INTO groups (organization_id, name)
		VALUES ($1, $2)
		RETURNING id
	`, organizationID, name).Scan(&groupID)
	if err != nil {
		t.Fatalf("insert group: %v", err)
	}

	return groupID
}

func insertTestGroupMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, groupID, userID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2)
	`, groupID, userID); err != nil {
		t.Fatalf("insert group member: %v", err)
	}
}

func insertWorkspaceGroupAccess(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, groupID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_group_access (workspace_id, group_id, role)
		VALUES ($1, $2, $3)
	`, workspaceID, groupID, role); err != nil {
		t.Fatalf("insert workspace group access: %v", err)
	}
}

func insertTestFolder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string, parentID *string, name string, position int) string {
	t.Helper()

	var folderID string
	err := pool.QueryRow(ctx, `
		INSERT INTO folders (workspace_id, parent_id, name, position)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, workspaceID, parentID, name, position).Scan(&folderID)
	if err != nil {
		t.Fatalf("insert folder: %v", err)
	}

	return folderID
}

func insertTestBookmark(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, folderID, title, rawURL string, position int) string {
	t.Helper()

	var bookmarkID string
	err := pool.QueryRow(ctx, `
		INSERT INTO bookmarks (workspace_id, folder_id, title, url, position)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, workspaceID, folderID, title, rawURL, position).Scan(&bookmarkID)
	if err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}

	return bookmarkID
}

func loadFolderPositions(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string) map[string]int {
	t.Helper()

	rows, err := pool.Query(ctx, `
		SELECT id, position
		FROM folders
		WHERE workspace_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
	`, workspaceID)
	if err != nil {
		t.Fatalf("query folder positions: %v", err)
	}
	defer rows.Close()

	positions := make(map[string]int)
	for rows.Next() {
		var (
			folderID string
			position int
		)
		if err := rows.Scan(&folderID, &position); err != nil {
			t.Fatalf("scan folder position: %v", err)
		}
		positions[folderID] = position
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate folder positions: %v", err)
	}

	return positions
}

func loadBookmarkPositions(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, folderID string) map[string]int {
	t.Helper()

	rows, err := pool.Query(ctx, `
		SELECT id, position
		FROM bookmarks
		WHERE workspace_id = $1 AND folder_id = $2 AND deleted_at IS NULL
	`, workspaceID, folderID)
	if err != nil {
		t.Fatalf("query bookmark positions: %v", err)
	}
	defer rows.Close()

	positions := make(map[string]int)
	for rows.Next() {
		var (
			bookmarkID string
			position   int
		)
		if err := rows.Scan(&bookmarkID, &position); err != nil {
			t.Fatalf("scan bookmark position: %v", err)
		}
		positions[bookmarkID] = position
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate bookmark positions: %v", err)
	}

	return positions
}

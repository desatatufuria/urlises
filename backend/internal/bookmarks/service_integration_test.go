package bookmarks

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

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
	workspaceID := insertTestWorkspace(t, ctx, pool)
	insertWorkspaceMember(t, ctx, pool, workspaceID, userID, "editor")
	existingFolderID := insertTestFolder(t, ctx, pool, workspaceID, nil, "Existing", 0)

	service := NewService(pool)
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

func insertTestWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
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

	return workspaceID
}

func insertWorkspaceMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1, $2, $3)
	`, workspaceID, userID, role); err != nil {
		t.Fatalf("insert workspace member: %v", err)
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

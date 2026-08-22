package access

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

// Slice 2b — RED: choke point 12. IsOrganizationAdmin rejects a would-be
// admin on a soft-deleted organization, returning (false, nil) rather than
// (true, nil). This closes activity.ListByOrganization and all 8 workspaces
// org-admin gates that call through this function.
func TestIsOrganizationAdminRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openAccessTestPool(t)
	adminID := insertAccessTestUser(t, ctx, pool, "cp12-admin@example.com")
	organizationID := insertAccessTestOrganization(t, ctx, pool, "CP12 Org")
	insertAccessTestMember(t, ctx, pool, organizationID, adminID, "admin")
	softDeleteAccessTestOrganization(t, ctx, pool, organizationID)

	isAdmin, err := IsOrganizationAdmin(ctx, pool, adminID, organizationID)
	if err != nil {
		t.Fatalf("is organization admin: %v", err)
	}
	if isAdmin {
		t.Fatal("isAdmin = true, want false for a soft-deleted organization")
	}

	if err := RequireOrganizationAdmin(ctx, pool, adminID, organizationID); err != ErrForbidden {
		t.Fatalf("RequireOrganizationAdmin err = %v, want %v", err, ErrForbidden)
	}
}

// Slice 2b — RED: choke point 13, the HIGHEST-LEVERAGE choke point in the
// whole inventory. loadWorkspaceMetadata (via GetEffectiveWorkspaceAccess)
// rejects a workspace whose organization has been soft-deleted, even though
// the workspace's own deleted_at stays NULL — reachability is enforced at
// the organization boundary, matching design.md's "org soft delete does not
// cascade to workspaces.deleted_at" decision.
func TestGetEffectiveWorkspaceAccessRejectsWorkspaceInSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openAccessTestPool(t)
	userID := insertAccessTestUser(t, ctx, pool, "cp13-org-user@example.com")
	organizationID := insertAccessTestOrganization(t, ctx, pool, "CP13 Org")
	workspaceID := insertAccessTestWorkspace(t, ctx, pool, organizationID, "CP13 Workspace")
	insertAccessTestWorkspaceUserAccess(t, ctx, pool, workspaceID, userID, "editor")
	softDeleteAccessTestOrganization(t, ctx, pool, organizationID)

	_, err := GetEffectiveWorkspaceAccess(ctx, pool, userID, workspaceID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	// The workspace row itself is untouched — org soft delete does not cascade.
	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM workspaces WHERE id = $1`, workspaceID).Scan(&deletedAt); err != nil {
		t.Fatalf("query workspace: %v", err)
	}
	if deletedAt != nil {
		t.Fatal("workspace deleted_at set, want nil (org soft delete must not cascade)")
	}
}

// Slice 2b — RED: choke point 13, the individually-soft-deleted-workspace
// half of the same predicate: a workspace with its own deleted_at set is
// rejected even though its organization stays live.
func TestGetEffectiveWorkspaceAccessRejectsSoftDeletedWorkspace(t *testing.T) {
	t.Parallel()

	ctx, pool := openAccessTestPool(t)
	userID := insertAccessTestUser(t, ctx, pool, "cp13-workspace-user@example.com")
	organizationID := insertAccessTestOrganization(t, ctx, pool, "CP13 Workspace Org")
	workspaceID := insertAccessTestWorkspace(t, ctx, pool, organizationID, "CP13 Workspace 2")
	insertAccessTestWorkspaceUserAccess(t, ctx, pool, workspaceID, userID, "editor")
	softDeleteAccessTestWorkspace(t, ctx, pool, workspaceID)

	_, err := GetEffectiveWorkspaceAccess(ctx, pool, userID, workspaceID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

func softDeleteAccessTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = NOW() WHERE id = $1`, organizationID); err != nil {
		t.Fatalf("soft delete organization fixture: %v", err)
	}
}

func softDeleteAccessTestWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE workspaces SET deleted_at = NOW() WHERE id = $1`, workspaceID); err != nil {
		t.Fatalf("soft delete workspace fixture: %v", err)
	}
}

func insertAccessTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()

	var userID string
	err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, email, "hash").Scan(&userID)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	return userID
}

func insertAccessTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
	t.Helper()

	var organizationID string
	err := pool.QueryRow(ctx, `
		INSERT INTO organizations (name)
		VALUES ($1)
		RETURNING id
	`, name).Scan(&organizationID)
	if err != nil {
		t.Fatalf("insert organization: %v", err)
	}

	return organizationID
}

func insertAccessTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func insertAccessTestWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, name string) string {
	t.Helper()

	var workspaceID string
	err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, $3)
		RETURNING id
	`, organizationID, name, "shared").Scan(&workspaceID)
	if err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	return workspaceID
}

func insertAccessTestWorkspaceUserAccess(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_user_access (workspace_id, user_id, role)
		VALUES ($1, $2, $3)
	`, workspaceID, userID, role); err != nil {
		t.Fatalf("insert workspace user access: %v", err)
	}
}

func openAccessTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("ACCESS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set ACCESS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
	}

	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	if err := adminPool.Ping(ctx); err != nil {
		adminPool.Close()
		t.Skipf("skipping PostgreSQL test: %v", err)
	}

	schemaName := fmt.Sprintf("access_test_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schemaName)); err != nil {
		adminPool.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := adminPool.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schemaName)); err != nil {
			t.Fatalf("drop schema: %v", err)
		}
		adminPool.Close()
	})

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database url: %v", err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open test pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := database.Migrate(ctx, pool, filepath.Clean(filepath.Join("..", "..", "migrations"))); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}

	return ctx, pool
}

package workspaces

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

func TestCreateWorkspaceGrantsOnlyCreatorAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil)
	creatorID := insertWorkspacesTestUser(t, ctx, pool, "creator@example.com")
	otherUserID := insertWorkspacesTestUser(t, ctx, pool, "other@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "OdA")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, creatorID, "owner")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, otherUserID, "member")

	workspace, err := service.Create(ctx, creatorID, organizationID, CreateWorkspaceInput{
		Name: "Synchronized operational space",
		Type: "operational",
	})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if workspace.Role != "admin" {
		t.Fatalf("workspace role = %q, want admin", workspace.Role)
	}
	if len(workspace.Sources) != 1 || workspace.Sources[0] != "direct" {
		t.Fatalf("workspace sources = %v, want [direct]", workspace.Sources)
	}

	var grantCount int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM workspace_user_access
		WHERE workspace_id = $1
	`, workspace.WorkspaceID).Scan(&grantCount); err != nil {
		t.Fatalf("count workspace grants: %v", err)
	}
	if grantCount != 1 {
		t.Fatalf("grant count = %d, want 1", grantCount)
	}

	_, err = service.GetAccessibleWorkspace(ctx, otherUserID, workspace.WorkspaceID)
	if err == nil {
		t.Fatal("expected non-granted organization member to be denied")
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

func TestWorkspaceAccessResolvesHighestRoleAndRecalculatesAfterRevokes(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil)
	adminID := insertWorkspacesTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "OdA")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")
	groupID := insertWorkspacesTestGroup(t, ctx, pool, organizationID, "monitoring")
	insertWorkspacesTestGroupMember(t, ctx, pool, groupID, memberID)

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{
		Name: "Ops",
		Type: "shared",
	})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, memberID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant direct viewer access: %v", err)
	}
	if _, err := service.GrantGroupAccess(ctx, adminID, workspace.WorkspaceID, groupID, UpdateGroupAccessInput{Role: "editor"}); err != nil {
		t.Fatalf("grant group editor access: %v", err)
	}

	granted, err := service.GetAccessibleWorkspace(ctx, memberID, workspace.WorkspaceID)
	if err != nil {
		t.Fatalf("get effective access: %v", err)
	}
	if granted.Role != "editor" {
		t.Fatalf("role = %q, want editor", granted.Role)
	}
	if strings.Join(granted.Sources, ",") != fmt.Sprintf("direct,group:%s", groupID) {
		t.Fatalf("sources = %v, want [direct group:%s]", granted.Sources, groupID)
	}

	if err := service.RevokeGroupAccess(ctx, adminID, workspace.WorkspaceID, groupID); err != nil {
		t.Fatalf("revoke group access: %v", err)
	}

	granted, err = service.GetAccessibleWorkspace(ctx, memberID, workspace.WorkspaceID)
	if err != nil {
		t.Fatalf("get access after group revoke: %v", err)
	}
	if granted.Role != "viewer" {
		t.Fatalf("role after group revoke = %q, want viewer", granted.Role)
	}
	if strings.Join(granted.Sources, ",") != "direct" {
		t.Fatalf("sources after group revoke = %v, want [direct]", granted.Sources)
	}

	if err := service.RevokeUserAccess(ctx, adminID, workspace.WorkspaceID, memberID); err != nil {
		t.Fatalf("revoke user access: %v", err)
	}

	_, err = service.GetAccessibleWorkspace(ctx, memberID, workspace.WorkspaceID)
	if err == nil {
		t.Fatal("expected access removal to deny workspace")
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

func openWorkspacesTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("WORKSPACES_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set WORKSPACES_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

	schemaName := fmt.Sprintf("workspaces_test_%d", time.Now().UnixNano())
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

func insertWorkspacesTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func insertWorkspacesTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
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

func insertWorkspacesTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func insertWorkspacesTestGroup(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, name string) string {
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

func insertWorkspacesTestGroupMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, groupID, userID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2)
	`, groupID, userID); err != nil {
		t.Fatalf("insert group member: %v", err)
	}
}

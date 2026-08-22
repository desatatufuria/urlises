package workspaces

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCreateWorkspaceGrantsOnlyCreatorAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
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
	service := NewService(pool, nil, activity.NewService(pool))
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

func TestGetAccessSnapshotReturnsRawAndEffectiveWorkspaceAccess(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "admin@example.com")
	viewerID := insertWorkspacesTestUser(t, ctx, pool, "viewer@example.com")
	editorID := insertWorkspacesTestUser(t, ctx, pool, "editor@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "OdA")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "owner")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, viewerID, "member")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, editorID, "member")
	groupID := insertWorkspacesTestGroup(t, ctx, pool, organizationID, "operators")
	insertWorkspacesTestGroupMember(t, ctx, pool, groupID, editorID)

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Ops", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, viewerID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant viewer access: %v", err)
	}
	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, editorID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant editor direct access: %v", err)
	}
	if _, err := service.GrantGroupAccess(ctx, adminID, workspace.WorkspaceID, groupID, UpdateGroupAccessInput{Role: "editor"}); err != nil {
		t.Fatalf("grant group access: %v", err)
	}

	snapshot, err := service.GetAccessSnapshot(ctx, adminID, workspace.WorkspaceID)
	if err != nil {
		t.Fatalf("get access snapshot: %v", err)
	}
	if snapshot.Workspace.WorkspaceID != workspace.WorkspaceID {
		t.Fatalf("workspace id = %q, want %q", snapshot.Workspace.WorkspaceID, workspace.WorkspaceID)
	}
	if len(snapshot.UserGrants) != 3 {
		t.Fatalf("user grant count = %d, want 3", len(snapshot.UserGrants))
	}
	if len(snapshot.GroupGrants) != 1 {
		t.Fatalf("group grant count = %d, want 1", len(snapshot.GroupGrants))
	}
	if snapshot.GroupGrants[0].GroupID != groupID || snapshot.GroupGrants[0].Role != "editor" {
		t.Fatalf("group grant = %+v, want group %s with editor role", snapshot.GroupGrants[0], groupID)
	}

	effectiveByEmail := make(map[string]WorkspaceEffectiveAccess, len(snapshot.EffectiveAccess))
	for _, subject := range snapshot.EffectiveAccess {
		effectiveByEmail[subject.Email] = subject
	}
	if effectiveByEmail["viewer@example.com"].Role != "viewer" {
		t.Fatalf("viewer effective role = %q, want viewer", effectiveByEmail["viewer@example.com"].Role)
	}
	editorAccess, ok := effectiveByEmail["editor@example.com"]
	if !ok {
		t.Fatalf("expected effective access entry for editor@example.com, got %+v", snapshot.EffectiveAccess)
	}
	if editorAccess.Role != "editor" {
		t.Fatalf("editor effective role = %q, want editor", editorAccess.Role)
	}
	if strings.Join(editorAccess.Sources, ",") != fmt.Sprintf("direct,group:%s", groupID) {
		t.Fatalf("editor sources = %v, want [direct group:%s]", editorAccess.Sources, groupID)
	}
}

func TestGetAccessSnapshotRejectsNonAdmins(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "OdA")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "owner")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Ops", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, memberID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant viewer access: %v", err)
	}

	snapshot, err := service.GetAccessSnapshot(ctx, memberID, workspace.WorkspaceID)
	if err == nil {
		t.Fatalf("expected non-admin access snapshot to fail, got %#v", snapshot)
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

// Phase 4: Workspaces Wiring — RED: CreateTx (invoked via Create's
// begin/commit wrapper) records a KindWorkspaceCreated event scoped to the
// newly created workspace's organization.
func TestCreateWorkspaceRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	creatorID := insertWorkspacesTestUser(t, ctx, pool, "create-activity-creator@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Activity Create Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, creatorID, "owner")

	workspace, err := service.Create(ctx, creatorID, organizationID, CreateWorkspaceInput{
		Name: "Activity Workspace",
		Type: "operational",
	})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, creatorID, activity.KindWorkspaceCreated, "workspace", workspace.WorkspaceID)
}

// Phase 4: Workspaces Wiring — RED: GrantUserAccess records a
// KindWorkspaceAccessUserGranted event.
func TestGrantUserAccessRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "grant-user-activity-admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "grant-user-activity-member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Activity Grant User Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "owner")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Ops", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, memberID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant user access: %v", err)
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceAccessUserGranted, "workspace_user_access", memberID)
}

// Phase 4: Workspaces Wiring — RED: RevokeUserAccess records a
// KindWorkspaceAccessUserRevoked event.
func TestRevokeUserAccessRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "revoke-user-activity-admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "revoke-user-activity-member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Activity Revoke User Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "owner")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Ops", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, memberID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant user access: %v", err)
	}

	if err := service.RevokeUserAccess(ctx, adminID, workspace.WorkspaceID, memberID); err != nil {
		t.Fatalf("revoke user access: %v", err)
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceAccessUserRevoked, "workspace_user_access", memberID)
}

// Phase 4: Workspaces Wiring — RED: GrantGroupAccess records a
// KindWorkspaceAccessGroupGranted event.
func TestGrantGroupAccessRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "grant-group-activity-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Activity Grant Group Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "owner")
	groupID := insertWorkspacesTestGroup(t, ctx, pool, organizationID, "grant-group-activity")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Ops", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	if _, err := service.GrantGroupAccess(ctx, adminID, workspace.WorkspaceID, groupID, UpdateGroupAccessInput{Role: "editor"}); err != nil {
		t.Fatalf("grant group access: %v", err)
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceAccessGroupGranted, "workspace_group_access", groupID)
}

// Phase 4: Workspaces Wiring — RED: RevokeGroupAccess records a
// KindWorkspaceAccessGroupRevoked event.
func TestRevokeGroupAccessRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "revoke-group-activity-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Activity Revoke Group Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "owner")
	groupID := insertWorkspacesTestGroup(t, ctx, pool, organizationID, "revoke-group-activity")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Ops", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := service.GrantGroupAccess(ctx, adminID, workspace.WorkspaceID, groupID, UpdateGroupAccessInput{Role: "editor"}); err != nil {
		t.Fatalf("grant group access: %v", err)
	}

	if err := service.RevokeGroupAccess(ctx, adminID, workspace.WorkspaceID, groupID); err != nil {
		t.Fatalf("revoke group access: %v", err)
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceAccessGroupRevoked, "workspace_group_access", groupID)
}

// Phase 3 (Slice 3) — RED: a non-admin member is forbidden from deleting a
// workspace, and the workspace row remains intact.
func TestDeleteWorkspaceRequiresAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "delete-admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "delete-member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Delete Workspace Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Doomed Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	err = service.Delete(ctx, memberID, workspace.WorkspaceID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	if countWorkspacesTestRows(t, ctx, pool, "workspaces", "id", workspace.WorkspaceID) != 1 {
		t.Fatalf("expected workspace to remain intact after a forbidden delete attempt")
	}
}

// Phase 3 (Slice 3) — RED: an unknown workspace ID returns ErrNotFound.
func TestDeleteWorkspaceUnknownReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "delete-admin2@example.com")

	err := service.Delete(ctx, adminID, "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Phase 3 (Slice 3) — RED: an admin deleting a workspace cascades away every
// child table (folders, bookmarks, workspace_cursors, sync_events,
// workspace_user_access, workspace_group_access) and records a
// workspace.deleted activity row in the same transaction.
func TestDeleteWorkspaceCascadesAndRecordsActivity(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "delete-admin3@example.com")
	viewerID := insertWorkspacesTestUser(t, ctx, pool, "delete-viewer3@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Cascade Delete Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, viewerID, "member")
	groupID := insertWorkspacesTestGroup(t, ctx, pool, organizationID, "Cascade Group")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Cascade Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	workspaceID := workspace.WorkspaceID

	if _, err := service.GrantUserAccess(ctx, adminID, workspaceID, viewerID, UpdateUserAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant user access: %v", err)
	}
	if _, err := service.GrantGroupAccess(ctx, adminID, workspaceID, groupID, UpdateGroupAccessInput{Role: "viewer"}); err != nil {
		t.Fatalf("grant group access: %v", err)
	}

	folderID := insertWorkspacesTestFolder(t, ctx, pool, workspaceID, "Folder A")
	insertWorkspacesTestBookmark(t, ctx, pool, workspaceID, folderID, "Bookmark A", "https://example.com/a")
	insertWorkspacesTestWorkspaceCursor(t, ctx, pool, workspaceID)
	insertWorkspacesTestSyncEvent(t, ctx, pool, organizationID, workspaceID, adminID)

	if err := service.Delete(ctx, adminID, workspaceID); err != nil {
		t.Fatalf("delete workspace: %v", err)
	}

	if countWorkspacesTestRows(t, ctx, pool, "workspaces", "id", workspaceID) != 0 {
		t.Fatalf("expected workspace row to be gone")
	}
	if countWorkspacesTestRows(t, ctx, pool, "folders", "workspace_id", workspaceID) != 0 {
		t.Fatalf("expected folders to cascade away")
	}
	if countWorkspacesTestRows(t, ctx, pool, "bookmarks", "workspace_id", workspaceID) != 0 {
		t.Fatalf("expected bookmarks to cascade away")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspace_cursors", "workspace_id", workspaceID) != 0 {
		t.Fatalf("expected workspace_cursors to cascade away")
	}
	if countWorkspacesTestRows(t, ctx, pool, "sync_events", "workspace_id", workspaceID) != 0 {
		t.Fatalf("expected sync_events to cascade away")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspace_user_access", "workspace_id", workspaceID) != 0 {
		t.Fatalf("expected workspace_user_access to cascade away")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspace_group_access", "workspace_id", workspaceID) != 0 {
		t.Fatalf("expected workspace_group_access to cascade away")
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceDeleted, "workspace", workspaceID)
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

func insertWorkspacesTestFolder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, name string) string {
	t.Helper()

	var folderID string
	err := pool.QueryRow(ctx, `
		INSERT INTO folders (workspace_id, name, position)
		VALUES ($1, $2, 0)
		RETURNING id
	`, workspaceID, name).Scan(&folderID)
	if err != nil {
		t.Fatalf("insert folder: %v", err)
	}

	return folderID
}

func insertWorkspacesTestBookmark(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, folderID, title, url string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO bookmarks (workspace_id, folder_id, title, url, position)
		VALUES ($1, $2, $3, $4, 0)
	`, workspaceID, folderID, title, url); err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}
}

func insertWorkspacesTestWorkspaceCursor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO workspace_cursors (workspace_id, current_cursor)
		VALUES ($1, 1)
	`, workspaceID); err != nil {
		t.Fatalf("insert workspace cursor: %v", err)
	}
}

func insertWorkspacesTestSyncEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, workspaceID, userID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO sync_events (event_id, organization_id, workspace_id, user_id, origin_client_id, cursor, event_type, entity_type, entity_id, payload)
		VALUES ($1, $2, $3, $4, $5, 1, 'created', 'bookmark', gen_random_uuid(), '{}'::jsonb)
	`, "event-"+workspaceID, organizationID, workspaceID, userID, "origin-client"); err != nil {
		t.Fatalf("insert sync event: %v", err)
	}
}

// countWorkspacesTestRows counts rows in table where column = id. table and
// column are always static string literals from call sites in this file,
// never user input.
func countWorkspacesTestRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, column, id string) int {
	t.Helper()

	var count int
	query := fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s = $1", table, column)
	if err := pool.QueryRow(ctx, query, id).Scan(&count); err != nil {
		t.Fatalf("count rows in %s: %v", table, err)
	}

	return count
}

// assertWorkspacesTestActivityEvent asserts exactly one activity_events row
// exists matching the given organization/actor/kind/target, per the design's
// Call-Site Wiring table for workspaces/service.go.
func assertWorkspacesTestActivityEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, actorUserID string, kind activity.Kind, targetType, targetID string) {
	t.Helper()

	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM activity_events
		WHERE organization_id = $1 AND actor_user_id = $2 AND kind = $3 AND target_type = $4 AND target_id = $5
	`, organizationID, actorUserID, string(kind), targetType, targetID).Scan(&count)
	if err != nil {
		t.Fatalf("count activity events: %v", err)
	}
	if count != 1 {
		t.Fatalf("activity event count = %d, want 1 (organizationId=%s actorUserId=%s kind=%s targetType=%s targetId=%s)",
			count, organizationID, actorUserID, kind, targetType, targetID)
	}
}

package workspaces

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/furia/shared-bookmark-sync/backend/internal/purge"
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

// Slice 2a — RED: an admin deleting a workspace soft-deletes it (deleted_at
// and deleted_by_user_id set, row NOT gone) while every child table (folders,
// bookmarks, workspace_cursors, sync_events, workspace_user_access,
// workspace_group_access) survives intact — the opposite assertion from the
// pre-soft-delete hard-delete behavior this test previously covered. A
// workspace.deleted activity row is still recorded in the same transaction
// (unchanged from lifecycle-management). A second delete call on the now-
// trashed workspace is idempotent: ErrNotFound, not a silent no-op.
func TestDeleteWorkspaceSoftDeletesAndPreservesChildren(t *testing.T) {
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

	if countWorkspacesTestRows(t, ctx, pool, "workspaces", "id", workspaceID) != 1 {
		t.Fatalf("expected workspace row to survive soft delete")
	}
	var deletedAt *time.Time
	var deletedByUserID *string
	if err := pool.QueryRow(ctx, `SELECT deleted_at, deleted_by_user_id FROM workspaces WHERE id = $1`, workspaceID).Scan(&deletedAt, &deletedByUserID); err != nil {
		t.Fatalf("query soft-deleted workspace: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it set")
	}
	if deletedByUserID == nil || *deletedByUserID != adminID {
		t.Fatalf("deleted_by_user_id = %v, want %q", deletedByUserID, adminID)
	}

	if countWorkspacesTestRows(t, ctx, pool, "folders", "workspace_id", workspaceID) == 0 {
		t.Fatalf("expected folders to survive (soft delete cascades nothing)")
	}
	if countWorkspacesTestRows(t, ctx, pool, "bookmarks", "workspace_id", workspaceID) == 0 {
		t.Fatalf("expected bookmarks to survive")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspace_cursors", "workspace_id", workspaceID) == 0 {
		t.Fatalf("expected workspace_cursors to survive")
	}
	if countWorkspacesTestRows(t, ctx, pool, "sync_events", "workspace_id", workspaceID) == 0 {
		t.Fatalf("expected sync_events to survive")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspace_user_access", "workspace_id", workspaceID) == 0 {
		t.Fatalf("expected workspace_user_access to survive")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspace_group_access", "workspace_id", workspaceID) == 0 {
		t.Fatalf("expected workspace_group_access to survive")
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceDeleted, "workspace", workspaceID)

	// A second delete on the now-trashed workspace is idempotent: ErrNotFound, not a silent no-op.
	if err := service.Delete(ctx, adminID, workspaceID); err != ErrNotFound {
		t.Fatalf("second delete err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 2b — RED: choke point 14, organization half. ListByOrganization
// excludes every workspace of a soft-deleted organization.
func TestListByOrganizationExcludesWorkspacesOfSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "cp14-org-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "CP14 Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	if _, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "CP14 Workspace", Type: "shared"}); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	softDeleteWorkspacesTestOrganization(t, ctx, pool, organizationID)

	workspaces, err := service.ListByOrganization(ctx, adminID, organizationID)
	if err != nil {
		t.Fatalf("list by organization: %v", err)
	}
	if len(workspaces) != 0 {
		t.Fatalf("workspace count = %d, want 0 (organization is soft-deleted)", len(workspaces))
	}
}

// Slice 2b — RED: choke point 14, workspace half. ListByOrganization
// excludes an individually soft-deleted workspace even though its
// organization stays live.
func TestListByOrganizationExcludesSoftDeletedWorkspaceWithinLiveOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "cp14-workspace-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "CP14 Live Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	live, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "CP14 Live Workspace", Type: "shared"})
	if err != nil {
		t.Fatalf("create live workspace: %v", err)
	}
	doomed, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "CP14 Doomed Workspace", Type: "shared"})
	if err != nil {
		t.Fatalf("create doomed workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, doomed.WorkspaceID); err != nil {
		t.Fatalf("soft delete doomed workspace: %v", err)
	}

	workspaces, err := service.ListByOrganization(ctx, adminID, organizationID)
	if err != nil {
		t.Fatalf("list by organization: %v", err)
	}
	if len(workspaces) != 1 {
		t.Fatalf("workspace count = %d, want 1 (soft-deleted workspace must be excluded)", len(workspaces))
	}
	if workspaces[0].WorkspaceID != live.WorkspaceID {
		t.Fatalf("workspace id = %q, want %q", workspaces[0].WorkspaceID, live.WorkspaceID)
	}
}

// Slice 2b — RED: choke point 15. loadWorkspaceMetadataRecord makes Delete's
// own double-delete check return ErrNotFound once the workspace's
// organization has been soft-deleted, even though the workspace row itself
// was never touched.
func TestDeleteWorkspaceReturnsNotFoundWhenOrganizationIsSoftDeleted(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "cp15-delete-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "CP15 Delete Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "CP15 Workspace", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	softDeleteWorkspacesTestOrganization(t, ctx, pool, organizationID)

	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 2b — RED: choke point 15. loadWorkspaceMetadataRecord also gates
// GetAccessSnapshot the same way.
func TestGetAccessSnapshotReturnsNotFoundWhenOrganizationIsSoftDeleted(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "cp15-snapshot-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "CP15 Snapshot Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "CP15 Snapshot Workspace", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	softDeleteWorkspacesTestOrganization(t, ctx, pool, organizationID)

	if _, err := service.GetAccessSnapshot(ctx, adminID, workspace.WorkspaceID); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 2b — RED: choke point 16. loadWorkspaceOrganizationID makes
// GrantUserAccess (and by the identical shared lookup, RevokeUserAccess,
// GrantGroupAccess and RevokeGroupAccess) return ErrNotFound for a
// soft-deleted workspace.
func TestGrantUserAccessReturnsNotFoundForSoftDeletedWorkspace(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "cp16-admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "cp16-member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "CP16 Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "CP16 Workspace", Type: "shared"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete workspace: %v", err)
	}

	if _, err := service.GrantUserAccess(ctx, adminID, workspace.WorkspaceID, memberID, UpdateUserAccessInput{Role: "viewer"}); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 3a — RED (task 3.9): Restore succeeds inside a live organization
// and records a workspace.restored activity event.
func TestRestoreWorkspaceSucceedsInsideLiveOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "restore-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Restore Live Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Restore Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete workspace: %v", err)
	}

	if err := service.Restore(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("restore workspace: %v", err)
	}

	var deletedAt *time.Time
	var deletedByUserID *string
	if err := pool.QueryRow(ctx, `SELECT deleted_at, deleted_by_user_id FROM workspaces WHERE id = $1`, workspace.WorkspaceID).Scan(&deletedAt, &deletedByUserID); err != nil {
		t.Fatalf("query restored workspace: %v", err)
	}
	if deletedAt != nil {
		t.Fatalf("deleted_at = %v, want nil after restore", deletedAt)
	}
	if deletedByUserID != nil {
		t.Fatalf("deleted_by_user_id = %v, want nil after restore", deletedByUserID)
	}

	assertWorkspacesTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindWorkspaceRestored, "workspace", workspace.WorkspaceID)
}

// Slice 3a — RED (task 3.9): a workspace inside a soft-deleted organization
// is not individually restorable -- Restore returns ErrNotFound (the
// organization must be restored first; design.md "Restore admin gate for a
// workspace" decision).
func TestRestoreWorkspaceInsideSoftDeletedOrganizationReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "restore-org-trashed-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Restore Org Trashed Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Orphaned By Org Trash", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete workspace: %v", err)
	}
	softDeleteWorkspacesTestOrganization(t, ctx, pool, organizationID)

	if err := service.Restore(ctx, adminID, workspace.WorkspaceID); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 3a — RED (task 3.9): restoring an already-live workspace returns
// ErrNotFound (idempotency reuses ErrNotFound, no new sentinel).
func TestRestoreWorkspaceLiveWorkspaceReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "restore-live-workspace-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Restore Live Workspace Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Still Live Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	if err := service.Restore(ctx, adminID, workspace.WorkspaceID); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 3a — RED (task 3.9): a non-admin (plain member) attempting to
// restore a soft-deleted workspace gets ErrForbidden -- no admin-gate
// exception here, access.RequireOrganizationAdmin is org-liveness-filtered
// and correct as-is since the organization stays live.
func TestRestoreWorkspaceNonAdminIsForbidden(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "restore-nonadmin-admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "restore-nonadmin-member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Restore NonAdmin Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "NonAdmin Restore Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete workspace: %v", err)
	}

	if err := service.Restore(ctx, memberID, workspace.WorkspaceID); err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM workspaces WHERE id = $1`, workspace.WorkspaceID).Scan(&deletedAt); err != nil {
		t.Fatalf("query workspace: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it still set (restore must not have happened)")
	}
}

// Slice 3a — RED (task 3.11): ListDeleted returns only the workspaces the
// requester owns/admins, and purgeAt is exactly deletedAt + purge.Window.
func TestListDeletedWorkspacesReturnsOnlyRequesterAdministeredWorkspaces(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "trash-ws-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Trash WS Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Trash Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete workspace: %v", err)
	}

	// An unrelated organization's own trashed workspace must never appear.
	otherAdminID := insertWorkspacesTestUser(t, ctx, pool, "trash-ws-other-admin@example.com")
	otherOrganizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Trash WS Other Org")
	insertWorkspacesTestMember(t, ctx, pool, otherOrganizationID, otherAdminID, "admin")
	otherWorkspace, err := service.Create(ctx, otherAdminID, otherOrganizationID, CreateWorkspaceInput{Name: "Other Trash Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create other workspace: %v", err)
	}
	if err := service.Delete(ctx, otherAdminID, otherWorkspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete other workspace: %v", err)
	}

	deleted, err := service.ListDeleted(ctx, adminID)
	if err != nil {
		t.Fatalf("list deleted workspaces: %v", err)
	}
	if len(deleted) != 1 {
		t.Fatalf("deleted count = %d, want 1", len(deleted))
	}
	if deleted[0].WorkspaceID != workspace.WorkspaceID {
		t.Fatalf("workspace id = %q, want %q", deleted[0].WorkspaceID, workspace.WorkspaceID)
	}

	var wantPurgeAt string
	if err := pool.QueryRow(ctx, `
		SELECT (deleted_at + $2::interval)::text
		FROM workspaces WHERE id = $1
	`, workspace.WorkspaceID, fmt.Sprintf("%d seconds", int64(purge.Window/time.Second))).Scan(&wantPurgeAt); err != nil {
		t.Fatalf("query expected purgeAt: %v", err)
	}
	if deleted[0].PurgeAt != wantPurgeAt {
		t.Fatalf("purgeAt = %q, want %q (deletedAt + purge.Window)", deleted[0].PurgeAt, wantPurgeAt)
	}
}

// Slice 3a — RED (task 3.11): workspaces belonging to a soft-deleted
// (trashed) organization are excluded from ListDeleted even though the
// requester administers that organization -- they are only reachable by
// restoring the organization first (design.md "Trash: workspaces" query
// comment: o.deleted_at IS NULL is deliberate).
func TestListDeletedWorkspacesExcludesWorkspacesOfTrashedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "trash-ws-org-trashed-admin@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "Trash WS Org Trashed")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "Excluded Trash Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := service.Delete(ctx, adminID, workspace.WorkspaceID); err != nil {
		t.Fatalf("soft delete workspace: %v", err)
	}
	softDeleteWorkspacesTestOrganization(t, ctx, pool, organizationID)

	deleted, err := service.ListDeleted(ctx, adminID)
	if err != nil {
		t.Fatalf("list deleted workspaces: %v", err)
	}
	if len(deleted) != 0 {
		t.Fatalf("deleted count = %d, want 0 (organization itself is trashed)", len(deleted))
	}
}

// Task 2.34 — regression: DELETE /workspaces/{workspaceId} keeps its exact
// existing 204/403/404 status set after the soft-delete conversion (unit 2a)
// and the choke-point sweep (unit 2b) — only the persisted effect changed
// (soft vs. hard), never the HTTP contract. Wired against the real Service
// and a real database (unlike TestDeleteWorkspaceRouteStatuses in
// handler_test.go, which is stub-driven and cannot observe the persisted
// effect at all).
func TestDeleteWorkspaceRouteHTTPContractUnchangedBySoftDeleteConversion(t *testing.T) {
	t.Parallel()

	ctx, pool := openWorkspacesTestPool(t)
	service := NewService(pool, nil, activity.NewService(pool))
	adminID := insertWorkspacesTestUser(t, ctx, pool, "http-contract-admin@example.com")
	memberID := insertWorkspacesTestUser(t, ctx, pool, "http-contract-member@example.com")
	organizationID := insertWorkspacesTestOrganization(t, ctx, pool, "HTTP Contract Workspace Org")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertWorkspacesTestMember(t, ctx, pool, organizationID, memberID, "member")

	workspace, err := service.Create(ctx, adminID, organizationID, CreateWorkspaceInput{Name: "HTTP Contract Workspace", Type: "team"})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	currentUserID := memberID
	dynamicPrincipal := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: currentUserID})))
		})
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, dynamicPrincipal, service)

	// A non-admin member gets 403, and the row stays live.
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/workspaces/"+workspace.WorkspaceID, nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin delete status = %d, want 403", recorder.Code)
	}

	// The admin gets 204, and the row survives soft-deleted.
	currentUserID = adminID
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/workspaces/"+workspace.WorkspaceID, nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("admin delete status = %d, want 204", recorder.Code)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("admin delete body = %q, want empty", recorder.Body.String())
	}
	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM workspaces WHERE id = $1`, workspace.WorkspaceID).Scan(&deletedAt); err != nil {
		t.Fatalf("query workspace: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil after a successful delete, want it set (soft delete, row survives)")
	}
	if countWorkspacesTestRows(t, ctx, pool, "workspaces", "id", workspace.WorkspaceID) != 1 {
		t.Fatal("expected workspace row to survive soft delete")
	}

	// A second delete on the now-trashed workspace gets 404, not a silent
	// no-op 204.
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/workspaces/"+workspace.WorkspaceID, nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("second delete status = %d, want 404", recorder.Code)
	}
}

func softDeleteWorkspacesTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = NOW() WHERE id = $1`, organizationID); err != nil {
		t.Fatalf("soft delete organization fixture: %v", err)
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

package groups

import (
	"context"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Phase 5: Groups Transaction-Wrap Refactor & Wiring
//
// The four tests below were originally written (and passed) against
// NewService(pool) BEFORE the tx-wrap refactor, characterizing Update/
// Delete's pre-refactor success and not-found behavior. They were re-run
// unchanged after the tx-wrap refactor (5.2/5.3) and stayed green, proving
// the refactor is behavior-preserving. They now use the post-5.4
// NewService(pool, activityService) signature since every call site in this
// package was updated together with the constructor change.
//
// ListMembers' equivalent characterization already exists in
// service_integration_test.go (TestListMembersReturnsGroupMembershipForAdminsOnly,
// TestListMembersRejectsNonAdmins) and needed no changes beyond the
// NewService signature update — it records no activity event.

func TestUpdateRenamesGroupSuccessfully(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	updated, err := service.Update(ctx, adminID, organizationID, groupID, UpdateGroupInput{Name: "platform"})
	if err != nil {
		t.Fatalf("update group: %v", err)
	}
	if updated.Name != "platform" {
		t.Fatalf("name = %q, want %q", updated.Name, "platform")
	}

	var storedName string
	if err := pool.QueryRow(ctx, `SELECT name FROM groups WHERE id = $1`, groupID).Scan(&storedName); err != nil {
		t.Fatalf("query stored name: %v", err)
	}
	if storedName != "platform" {
		t.Fatalf("stored name = %q, want %q", storedName, "platform")
	}
}

func TestUpdateReturnsErrNotFoundWhenNoMatch(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	_, err := service.Update(ctx, adminID, organizationID, "00000000-0000-0000-0000-000000000000", UpdateGroupInput{Name: "ghost"})
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

func TestDeleteRemovesGroupSuccessfully(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	if err := service.Delete(ctx, adminID, organizationID, groupID); err != nil {
		t.Fatalf("delete group: %v", err)
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM groups WHERE id = $1`, groupID).Scan(&count); err != nil {
		t.Fatalf("count groups: %v", err)
	}
	if count != 0 {
		t.Fatalf("count = %d, want 0", count)
	}
}

func TestDeleteReturnsErrNotFoundWhenNoMatch(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	err := service.Delete(ctx, adminID, organizationID, "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Phase 5: Groups Transaction-Wrap Refactor & Wiring — RED: the 5 activity
// call sites from design's Call-Site Wiring table for groups/service.go.

func TestCreateGroupRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	group, err := service.Create(ctx, adminID, organizationID, CreateGroupInput{Name: "devops"})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}

	assertGroupsTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindGroupCreated, "group", group.ID)
}

func TestUpdateGroupRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	if _, err := service.Update(ctx, adminID, organizationID, groupID, UpdateGroupInput{Name: "platform"}); err != nil {
		t.Fatalf("update group: %v", err)
	}

	assertGroupsTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindGroupRenamed, "group", groupID)
}

func TestDeleteGroupRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	if err := service.Delete(ctx, adminID, organizationID, groupID); err != nil {
		t.Fatalf("delete group: %v", err)
	}

	assertGroupsTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindGroupDeleted, "group", groupID)
}

func TestAddMemberRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertGroupsTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertGroupsTestMember(t, ctx, pool, organizationID, memberID, "member")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	if _, err := service.AddMember(ctx, adminID, groupID, AddGroupMemberInput{UserID: memberID}); err != nil {
		t.Fatalf("add group member: %v", err)
	}

	assertGroupsTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindGroupMemberAdded, "group_member", memberID)
}

func TestRemoveMemberRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertGroupsTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertGroupsTestMember(t, ctx, pool, organizationID, memberID, "member")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")
	insertGroupsTestGroupMember(t, ctx, pool, groupID, memberID)

	if err := service.RemoveMember(ctx, adminID, groupID, memberID); err != nil {
		t.Fatalf("remove group member: %v", err)
	}

	assertGroupsTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindGroupMemberRemoved, "group_member", memberID)
}

// assertGroupsTestActivityEvent asserts exactly one activity_events row
// exists matching the given organization/actor/kind/target, per the design's
// Call-Site Wiring table for groups/service.go.
func assertGroupsTestActivityEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, actorUserID string, kind activity.Kind, targetType, targetID string) {
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

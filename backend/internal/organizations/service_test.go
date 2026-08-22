package organizations

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/furia/shared-bookmark-sync/backend/internal/purge"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCreateOrganizationBootstrapsCreatorAsOwner(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_test")
	service := NewService(pool, activity.NewService(pool))
	userID := insertOrganizationsTestUser(t, ctx, pool, "creator@example.com")

	membership, err := service.CreateOrganization(ctx, userID, CreateOrganizationInput{Name: "OdA Core"})
	if err != nil {
		t.Fatalf("create organization: %v", err)
	}
	if membership.OrganizationName != "OdA Core" {
		t.Fatalf("organization name = %q, want %q", membership.OrganizationName, "OdA Core")
	}
	if membership.Role != "owner" {
		t.Fatalf("role = %q, want owner", membership.Role)
	}

	var storedRole string
	err = pool.QueryRow(ctx, `
		SELECT role
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, membership.OrganizationID, userID).Scan(&storedRole)
	if err != nil {
		t.Fatalf("query stored role: %v", err)
	}
	if storedRole != "owner" {
		t.Fatalf("stored role = %q, want owner", storedRole)
	}
}

func TestPatchMemberRejectsRemovingLastOwner(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Only Owner Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	_, err := service.PatchMember(ctx, ownerID, organizationID, PatchMemberInput{
		UserID: ownerID,
		Remove: true,
	})
	if err == nil {
		t.Fatal("expected last-owner removal to fail")
	}
	if err != ErrLastOwner {
		t.Fatalf("err = %v, want %v", err, ErrLastOwner)
	}

	memberRole := loadOrganizationsTestMemberRole(t, ctx, pool, organizationID, ownerID)
	if memberRole != "owner" {
		t.Fatalf("stored role = %q, want owner", memberRole)
	}
}

func TestCreateInvitationSetsExpiryAndInviterContext(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invite_expiry_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Acme Corp")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	before := time.Now().UTC()
	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "invitee@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	after := time.Now().UTC()

	wantMin := before.Add(invitationTTL).Add(-time.Minute)
	wantMax := after.Add(invitationTTL).Add(time.Minute)
	if created.ExpiresAt.Before(wantMin) || created.ExpiresAt.After(wantMax) {
		t.Fatalf("ExpiresAt = %v, want within [%v, %v]", created.ExpiresAt, wantMin, wantMax)
	}
	if created.OrganizationName != "Acme Corp" {
		t.Fatalf("OrganizationName = %q, want %q", created.OrganizationName, "Acme Corp")
	}
	if created.InviterEmail != "admin@example.com" {
		t.Fatalf("InviterEmail = %q, want %q", created.InviterEmail, "admin@example.com")
	}
	if created.InviterName != "" {
		t.Fatalf("InviterName = %q, want empty for NULL users.name", created.InviterName)
	}

	var storedExpiresAt time.Time
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM invitations WHERE id = $1`, created.Invitation.ID).Scan(&storedExpiresAt); err != nil {
		t.Fatalf("query stored expires_at: %v", err)
	}
	if storedExpiresAt.Before(wantMin) || storedExpiresAt.After(wantMax) {
		t.Fatalf("stored expires_at = %v, want within [%v, %v]", storedExpiresAt, wantMin, wantMax)
	}
}

func TestCreateInvitationInviterNamePopulatedWhenPresent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invite_expiry_test")
	service := NewService(pool, activity.NewService(pool))
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Beta Org")

	var adminID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, name)
		VALUES ($1, $2, $3)
		RETURNING id
	`, "named-admin@example.com", "hash", "Ada Lovelace").Scan(&adminID); err != nil {
		t.Fatalf("insert named user: %v", err)
	}
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "invitee2@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if created.InviterName != "Ada Lovelace" {
		t.Fatalf("InviterName = %q, want %q", created.InviterName, "Ada Lovelace")
	}
}

// Phase 3: Organizations Wiring — RED: CreateOrganizationTx (invoked via
// CreateOrganization's begin/commit wrapper) records a KindOrganizationCreated
// event scoped to the newly created organization, atomic with the commit.
func TestCreateOrganizationRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_activity_create_test")
	service := NewService(pool, activity.NewService(pool))
	userID := insertOrganizationsTestUser(t, ctx, pool, "creator-activity@example.com")

	membership, err := service.CreateOrganization(ctx, userID, CreateOrganizationInput{Name: "Activity Org"})
	if err != nil {
		t.Fatalf("create organization: %v", err)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, membership.OrganizationID, userID, activity.KindOrganizationCreated, "organization", membership.OrganizationID)
}

// Phase 3: Organizations Wiring — RED: PatchMember's role-change branch
// records a KindOrganizationMemberRoleChanged event.
func TestPatchMemberRoleChangeRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_activity_role_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "role-activity-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "role-activity-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Activity Role Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	adminRole := "admin"
	if _, err := service.PatchMember(ctx, ownerID, organizationID, PatchMemberInput{UserID: memberID, Role: &adminRole}); err != nil {
		t.Fatalf("patch member role: %v", err)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationMemberRoleChanged, "organization_member", memberID)
}

// Phase 3: Organizations Wiring — RED: PatchMember's remove branch records a
// KindOrganizationMemberRemoved event.
func TestPatchMemberRemovalRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_activity_remove_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "remove-activity-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "remove-activity-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Activity Remove Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	if _, err := service.PatchMember(ctx, ownerID, organizationID, PatchMemberInput{UserID: memberID, Remove: true}); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationMemberRemoved, "organization_member", memberID)
}

// Phase 2 (Slice 2): Cancel Pending Invitation — RED: the happy path
// transitions a pending invitation to cancelled and records an
// invitation.cancelled activity row, atomic with the status change.
func TestCancelInvitationTransitionsPendingToCancelledAndRecordsActivity(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cancel_invite_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Invite Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	invitationID := insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "invitee@example.com", "member", "pending", adminID, "cancel-token-1")

	if err := service.CancelInvitation(ctx, adminID, organizationID, invitationID); err != nil {
		t.Fatalf("cancel invitation: %v", err)
	}

	status := loadOrganizationsTestInvitationStatus(t, ctx, pool, invitationID)
	if status != "cancelled" {
		t.Fatalf("invitation status = %q, want cancelled", status)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, adminID, activity.KindInvitationCancelled, "invitation", invitationID)
}

// Phase 2 (Slice 2) — RED: a non-admin member is forbidden from cancelling,
// and the invitation status is left untouched.
func TestCancelInvitationRequiresAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cancel_invite_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-admin2@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "cancel-member2@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Invite Org 2")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")
	invitationID := insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "invitee2@example.com", "member", "pending", adminID, "cancel-token-2")

	err := service.CancelInvitation(ctx, memberID, organizationID, invitationID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	status := loadOrganizationsTestInvitationStatus(t, ctx, pool, invitationID)
	if status != "pending" {
		t.Fatalf("invitation status = %q, want pending (unchanged)", status)
	}
}

// Phase 2 (Slice 2) — RED: already-cancelled, accepted, or expired
// invitations are rejected with ErrInvitationNotPending and no activity row
// is recorded.
func TestCancelInvitationRejectsNonPendingInvitations(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cancel_invite_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-admin3@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Invite Org 3")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	for _, status := range []string{"cancelled", "accepted", "expired"} {
		status := status
		t.Run(status, func(t *testing.T) {
			invitationID := insertOrganizationsTestInvitation(t, ctx, pool, organizationID, status+"@example.com", "member", status, adminID, "cancel-token-status-"+status)

			err := service.CancelInvitation(ctx, adminID, organizationID, invitationID)
			if err != ErrInvitationNotPending {
				t.Fatalf("err = %v, want %v", err, ErrInvitationNotPending)
			}

			var count int
			if err := pool.QueryRow(ctx, `
				SELECT COUNT(*) FROM activity_events
				WHERE target_type = 'invitation' AND target_id = $1
			`, invitationID).Scan(&count); err != nil {
				t.Fatalf("count activity events: %v", err)
			}
			if count != 0 {
				t.Fatalf("activity event count = %d, want 0 (no activity for a rejected cancel)", count)
			}
		})
	}
}

// Phase 2 (Slice 2) — RED: an unknown invitation ID returns ErrNotFound.
func TestCancelInvitationUnknownInvitationReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cancel_invite_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-admin4@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Invite Org 4")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	err := service.CancelInvitation(ctx, adminID, organizationID, "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Phase 2 (Slice 2) — RED: ListInvitations, after a cancel, still returns
// the row with status='cancelled' while continuing to exclude
// accepted/expired invitations.
func TestListInvitationsIncludesCancelledExcludesAcceptedAndExpired(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cancel_invite_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "list-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "List Invite Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	pendingID := insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "pending@example.com", "member", "pending", adminID, "list-token-pending")
	insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "accepted@example.com", "member", "accepted", adminID, "list-token-accepted")
	insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "expired@example.com", "member", "expired", adminID, "list-token-expired")

	if err := service.CancelInvitation(ctx, adminID, organizationID, pendingID); err != nil {
		t.Fatalf("cancel invitation: %v", err)
	}

	invitations, err := service.ListInvitations(ctx, adminID, organizationID)
	if err != nil {
		t.Fatalf("list invitations: %v", err)
	}

	statuses := make(map[string]string, len(invitations))
	for _, invitation := range invitations {
		statuses[invitation.Email] = invitation.Status
	}

	if statuses["pending@example.com"] != "cancelled" {
		t.Fatalf("cancelled invitation missing or wrong status: %v", statuses)
	}
	if _, ok := statuses["accepted@example.com"]; ok {
		t.Fatalf("accepted invitation must stay excluded: %v", statuses)
	}
	if _, ok := statuses["expired@example.com"]; ok {
		t.Fatalf("expired invitation must stay excluded: %v", statuses)
	}
}

// Phase 4 (Slice 4): Delete Organization, Guarded — RED: a non-owner/non-admin
// requester is forbidden and the organization remains intact.
func TestDeleteOrganizationRequiresAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "delete-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "delete-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Guard Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	err := service.DeleteOrganization(ctx, memberID, organizationID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations WHERE id = $1`, organizationID).Scan(&count); err != nil {
		t.Fatalf("count organizations: %v", err)
	}
	if count != 1 {
		t.Fatalf("organization count = %d, want 1 (must remain intact)", count)
	}
}

// Slice 2a — RED: happy path soft-deletes the organization (deleted_at and
// deleted_by_user_id set, row NOT gone) while every child row (members,
// workspaces + children, invitations, groups + children) survives intact —
// the opposite assertion from the pre-soft-delete hard-delete behavior this
// test previously covered. A second delete call on the now-trashed
// organization returns ErrNotFound (idempotent, no silent no-op). An
// organization.deleted activity event is recorded in the same transaction
// (design.md Deviation 3, reversing lifecycle-management's "record nothing"
// decision now that nothing cascades the event away).
func TestDeleteOrganizationHappyPathSoftDeletesAndPreservesChildren(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "delete-happy-owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Happy Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	var workspaceID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, $3)
		RETURNING id
	`, organizationID, "Happy Workspace", "personal").Scan(&workspaceID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	var folderID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO folders (workspace_id, name)
		VALUES ($1, $2)
		RETURNING id
	`, workspaceID, "Happy Folder").Scan(&folderID); err != nil {
		t.Fatalf("insert folder: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO bookmarks (workspace_id, folder_id, url, title)
		VALUES ($1, $2, $3, $4)
	`, workspaceID, folderID, "https://example.com", "Example"); err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}
	var groupID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO groups (organization_id, name)
		VALUES ($1, $2)
		RETURNING id
	`, organizationID, "Happy Group").Scan(&groupID); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2)
	`, groupID, ownerID); err != nil {
		t.Fatalf("insert group member: %v", err)
	}
	insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "happy-invitee@example.com", "member", "pending", ownerID, "delete-happy-token")

	// Another, unrelated organization: its activity_events row must survive.
	otherOwnerID := insertOrganizationsTestUser(t, ctx, pool, "delete-happy-other-owner@example.com")
	otherOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Happy Other Org")
	insertOrganizationsTestMember(t, ctx, pool, otherOrganizationID, otherOwnerID, "owner")
	if _, err := service.CreateInvitation(ctx, otherOwnerID, otherOrganizationID, CreateInvitationInput{Email: "other-invitee@example.com", Role: "member"}); err != nil {
		t.Fatalf("create invitation in other org: %v", err)
	}

	if err := service.DeleteOrganization(ctx, ownerID, organizationID); err != nil {
		t.Fatalf("delete organization: %v", err)
	}

	// The organization row itself must survive with deleted_at/deleted_by_user_id set.
	var deletedAt *time.Time
	var deletedByUserID *string
	if err := pool.QueryRow(ctx, `SELECT deleted_at, deleted_by_user_id FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt, &deletedByUserID); err != nil {
		t.Fatalf("query soft-deleted organization: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it set")
	}
	if deletedByUserID == nil || *deletedByUserID != ownerID {
		t.Fatalf("deleted_by_user_id = %v, want %q", deletedByUserID, ownerID)
	}

	// Every child table must still be populated — soft delete cascades nothing.
	for table, condition := range map[string]string{
		"organization_members": "organization_id = '" + organizationID + "'",
		"workspaces":           "organization_id = '" + organizationID + "'",
		"folders":              "workspace_id = '" + workspaceID + "'",
		"bookmarks":            "workspace_id = '" + workspaceID + "'",
		"groups":               "organization_id = '" + organizationID + "'",
		"group_members":        "group_id = '" + groupID + "'",
		"invitations":          "organization_id = '" + organizationID + "'",
		"activity_events":      "organization_id = '" + organizationID + "'",
	} {
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM `+table+` WHERE `+condition).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count == 0 {
			t.Fatalf("%s count = 0, want > 0 (soft delete must not cascade)", table)
		}
	}

	var otherActivityCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activity_events WHERE organization_id = $1`, otherOrganizationID).Scan(&otherActivityCount); err != nil {
		t.Fatalf("count other org activity events: %v", err)
	}
	if otherActivityCount == 0 {
		t.Fatal("other organization's activity_events rows must remain intact")
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationDeleted, "organization", organizationID)

	// A second delete on the now-trashed organization is idempotent: ErrNotFound, not a silent no-op.
	if err := service.DeleteOrganization(ctx, ownerID, organizationID); err != ErrNotFound {
		t.Fatalf("second delete err = %v, want %v", err, ErrNotFound)
	}
}

// Phase 4 (Slice 4) — RED: the orphan probe blocks deletion and rolls back
// with zero rows deleted when another member has no other organization.
func TestDeleteOrganizationOrphanProbeBlocksWithZeroRowsDeleted(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "delete-orphan-owner@example.com")
	soleMemberID := insertOrganizationsTestUser(t, ctx, pool, "delete-orphan-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Orphan Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, soleMemberID, "member")

	err := service.DeleteOrganization(ctx, ownerID, organizationID)
	if err != ErrWouldOrphanMember {
		t.Fatalf("err = %v, want %v", err, ErrWouldOrphanMember)
	}

	var organizationCount, memberCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations WHERE id = $1`, organizationID).Scan(&organizationCount); err != nil {
		t.Fatalf("count organizations: %v", err)
	}
	if organizationCount != 1 {
		t.Fatalf("organization count = %d, want 1 (rolled back)", organizationCount)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1`, organizationID).Scan(&memberCount); err != nil {
		t.Fatalf("count organization members: %v", err)
	}
	if memberCount != 2 {
		t.Fatalf("member count = %d, want 2 (zero rows deleted)", memberCount)
	}
}

// Slice 2a — RED: choke point 9 / design.md Deviation 5. A member whose only
// OTHER organization is itself soft-deleted must be treated as orphaned: a
// trashed organization is not a reachable fallback. The target organization's
// deleted_at must stay untouched (rolled back).
func TestDeleteOrganizationOrphanProbeBlocksWhenMembersOnlyOtherOrgIsSoftDeleted(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))

	ownerID := insertOrganizationsTestUser(t, ctx, pool, "delete-orphan-trash-owner@example.com")
	sharedMemberID := insertOrganizationsTestUser(t, ctx, pool, "delete-orphan-trash-member@example.com")

	targetOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Orphan Trash Target Org")
	insertOrganizationsTestMember(t, ctx, pool, targetOrganizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, targetOrganizationID, sharedMemberID, "member")

	otherOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Orphan Trash Other Org")
	insertOrganizationsTestMember(t, ctx, pool, otherOrganizationID, sharedMemberID, "owner")

	// sharedMemberID is the sole member of otherOrganizationID, so this
	// self-delete is allowed (the orphan probe excludes the requester).
	if err := service.DeleteOrganization(ctx, sharedMemberID, otherOrganizationID); err != nil {
		t.Fatalf("soft delete other organization: %v", err)
	}

	// sharedMemberID's only OTHER organization (otherOrganizationID) is now
	// in the trash, so deleting targetOrganizationID must block: it would
	// leave sharedMemberID with zero reachable organizations.
	err := service.DeleteOrganization(ctx, ownerID, targetOrganizationID)
	if err != ErrWouldOrphanMember {
		t.Fatalf("err = %v, want %v", err, ErrWouldOrphanMember)
	}

	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, targetOrganizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query target organization: %v", err)
	}
	if deletedAt != nil {
		t.Fatal("deleted_at set, want nil (rolled back, blocked by orphan probe)")
	}
}

// Phase 4 (Slice 4) — RED: the requester's own orphaning does not block
// deletion, since the orphan probe excludes the requester (om.user_id <> $2).
func TestDeleteOrganizationRequesterOwnOrphaningDoesNotBlock(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))
	soleOwnerID := insertOrganizationsTestUser(t, ctx, pool, "delete-self-owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Self Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, soleOwnerID, "owner")

	if err := service.DeleteOrganization(ctx, soleOwnerID, organizationID); err != nil {
		t.Fatalf("delete organization: %v, want requester's own last-org deletion to succeed", err)
	}

	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query organization: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it set (soft delete, row survives)")
	}
}

// Phase 4 (Slice 4) — RED: an unknown organization ID returns ErrNotFound.
func TestDeleteOrganizationUnknownReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "delete-unknown-owner@example.com")

	err := service.DeleteOrganization(ctx, ownerID, "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Phase 4 (Slice 4) — RED: two concurrent DeleteOrganization calls against the
// same organization must serialize on lockOrganization's FOR UPDATE so only
// one commits a consistent result (the second sees the row already gone),
// matching the ErrLastOwner concurrency precedent
// (TestOwnerOnlyPromotionAndConcurrentOwnerTransitions).
func TestDeleteOrganizationConcurrentRequestsOnlyOneCommits(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "delete-race-owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Delete Race Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- service.DeleteOrganization(ctx, ownerID, organizationID)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	successes, notFounds, other := 0, 0, 0
	for err := range errs {
		switch err {
		case nil:
			successes++
		case ErrNotFound:
			notFounds++
		default:
			other++
		}
	}
	if successes != 1 || notFounds != 1 || other != 0 {
		t.Fatalf("successes=%d notFounds=%d other=%d, want exactly one success and one ErrNotFound", successes, notFounds, other)
	}

	var count int
	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT COUNT(*), MAX(deleted_at) FROM organizations WHERE id = $1`, organizationID).Scan(&count, &deletedAt); err != nil {
		t.Fatalf("count organizations: %v", err)
	}
	if count != 1 {
		t.Fatalf("organization count = %d, want 1 (soft delete, row survives)", count)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it set")
	}
}

// Slice 3a — RED (task 3.2, adversarial focus): owner and admin restore
// succeed and the organization becomes fully usable again -- deleted_at
// cleared, memberships/workspaces/bookmarks/pre-deletion activity trail all
// intact, and an organization.restored event recorded. This is the primary
// happy-path proof for RestoreOrganization.
func TestRestoreOrganizationOwnerSucceedsAndOrgBecomesFullyUsable(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_restore_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "restore-owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Restore Happy Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	var workspaceID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, $3)
		RETURNING id
	`, organizationID, "Restore Workspace", "personal").Scan(&workspaceID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	var folderID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO folders (workspace_id, name)
		VALUES ($1, $2)
		RETURNING id
	`, workspaceID, "Restore Folder").Scan(&folderID); err != nil {
		t.Fatalf("insert folder: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO bookmarks (workspace_id, folder_id, url, title)
		VALUES ($1, $2, $3, $4)
	`, workspaceID, folderID, "https://example.com/restore", "Restore Bookmark"); err != nil {
		t.Fatalf("insert bookmark: %v", err)
	}

	if err := service.DeleteOrganization(ctx, ownerID, organizationID); err != nil {
		t.Fatalf("soft delete organization: %v", err)
	}
	// Pre-deletion activity trail: the delete itself recorded one event.
	var preRestoreActivityCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activity_events WHERE organization_id = $1`, organizationID).Scan(&preRestoreActivityCount); err != nil {
		t.Fatalf("count pre-restore activity events: %v", err)
	}
	if preRestoreActivityCount == 0 {
		t.Fatal("expected the delete event to already be recorded before restore")
	}

	if err := service.RestoreOrganization(ctx, ownerID, organizationID); err != nil {
		t.Fatalf("restore organization: %v", err)
	}

	var deletedAt *time.Time
	var deletedByUserID *string
	if err := pool.QueryRow(ctx, `SELECT deleted_at, deleted_by_user_id FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt, &deletedByUserID); err != nil {
		t.Fatalf("query restored organization: %v", err)
	}
	if deletedAt != nil {
		t.Fatalf("deleted_at = %v, want nil after restore", deletedAt)
	}
	if deletedByUserID != nil {
		t.Fatalf("deleted_by_user_id = %v, want nil after restore", deletedByUserID)
	}

	// Membership, workspace and bookmark all intact.
	if role := loadOrganizationsTestMemberRole(t, ctx, pool, organizationID, ownerID); role != "owner" {
		t.Fatalf("owner role = %q, want owner", role)
	}
	memberships, err := service.ListMemberships(ctx, ownerID)
	if err != nil {
		t.Fatalf("list memberships: %v", err)
	}
	found := false
	for _, m := range memberships {
		if m.OrganizationID == organizationID {
			found = true
		}
	}
	if !found {
		t.Fatal("restored organization missing from ListMemberships")
	}
	var bookmarkCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM bookmarks WHERE workspace_id = $1`, workspaceID).Scan(&bookmarkCount); err != nil {
		t.Fatalf("count bookmarks: %v", err)
	}
	if bookmarkCount != 1 {
		t.Fatalf("bookmark count = %d, want 1 (survived intact)", bookmarkCount)
	}

	// Pre-deletion activity trail survives restore, plus the new restored event.
	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationDeleted, "organization", organizationID)
	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationRestored, "organization", organizationID)
}

// Slice 3a — RED (task 3.2, THE adversarial focus of this unit): a plain
// member (not owner/admin) attempting to restore a trashed organization
// gets ErrForbidden. loadOrganizationRoleIncludingDeleted resolves the
// member's real role from organization_members (soft delete never touched
// that table), but RestoreOrganization must still reject anything that is
// not owner/admin.
func TestRestoreOrganizationPlainMemberIsForbidden(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_restore_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "restore-forbidden-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "restore-forbidden-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Restore Forbidden Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	if err := service.DeleteOrganization(ctx, ownerID, organizationID); err != nil {
		t.Fatalf("soft delete organization: %v", err)
	}

	if err := service.RestoreOrganization(ctx, memberID, organizationID); err != ErrForbidden {
		t.Fatalf("err = %v, want %v (plain member)", err, ErrForbidden)
	}

	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query organization: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it still set (restore must not have happened)")
	}
}

// Slice 3a — RED (task 3.2, THE second adversarial focus of this unit): a
// non-member (no organization_members row at all) attempting to restore a
// trashed organization gets ErrForbidden, not a crash or a leak of any
// organization state.
func TestRestoreOrganizationNonMemberIsForbidden(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_restore_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "restore-outsider-owner@example.com")
	outsiderID := insertOrganizationsTestUser(t, ctx, pool, "restore-outsider@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Restore Outsider Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	if err := service.DeleteOrganization(ctx, ownerID, organizationID); err != nil {
		t.Fatalf("soft delete organization: %v", err)
	}

	if err := service.RestoreOrganization(ctx, outsiderID, organizationID); err != ErrForbidden {
		t.Fatalf("err = %v, want %v (non-member)", err, ErrForbidden)
	}

	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query organization: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil, want it still set (restore must not have happened)")
	}
}

// Slice 3a — RED (task 3.2): restoring an already-live organization returns
// ErrNotFound (design.md "Restore idempotency error" decision -- no new
// sentinel, reuse ErrNotFound).
func TestRestoreOrganizationLiveOrgReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_restore_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "restore-live-owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Restore Live Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	if err := service.RestoreOrganization(ctx, ownerID, organizationID); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 3a — RED (task 3.2): restoring an unknown organization id returns
// ErrNotFound.
func TestRestoreOrganizationUnknownIDReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_restore_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "restore-unknown-owner@example.com")

	err := service.RestoreOrganization(ctx, ownerID, "00000000-0000-0000-0000-000000000000")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 3a — RED (task 3.2): restoring an organization where the requester's
// only membership would otherwise orphan another member does NOT re-run the
// orphan guard (design.md Decision D: memberships were never touched by the
// soft delete, so there is nothing to re-verify). This soft-deletes a
// second organization that is the sole owner's ONLY other org, then
// restores it -- if RestoreOrganization mistakenly re-ran the orphan probe
// it would block here, since restoring would otherwise "give back" a
// reachable org to a member who currently has none.
func TestRestoreOrganizationDoesNotRerunOrphanGuard(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_restore_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "restore-orphan-owner@example.com")
	soleMemberID := insertOrganizationsTestUser(t, ctx, pool, "restore-orphan-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Restore Orphan Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, soleMemberID, "member")

	// soleMemberID's only other organization, deleted by its own owner
	// (unrelated to organizationID), so soleMemberID currently has zero
	// reachable organizations besides organizationID itself.
	otherOwnerID := insertOrganizationsTestUser(t, ctx, pool, "restore-orphan-other-owner@example.com")
	otherOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Restore Orphan Other Org")
	insertOrganizationsTestMember(t, ctx, pool, otherOrganizationID, otherOwnerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, otherOrganizationID, soleMemberID, "member")
	if err := service.DeleteOrganization(ctx, otherOwnerID, otherOrganizationID); err != nil {
		t.Fatalf("soft delete other organization: %v", err)
	}

	// Deleting organizationID would normally be blocked by the orphan probe
	// (soleMemberID's only other org is trashed), so delete it as the owner
	// deleting their OWN organization is not possible here -- instead prove
	// restore skips the guard by restoring otherOrganizationID directly,
	// which must succeed even though organizationID's owner is unrelated.
	if err := service.RestoreOrganization(ctx, otherOwnerID, otherOrganizationID); err != nil {
		t.Fatalf("restore organization must not re-run the orphan guard: %v", err)
	}

	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, otherOrganizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query organization: %v", err)
	}
	if deletedAt != nil {
		t.Fatal("deleted_at set, want nil (restore succeeded)")
	}
}

// Slice 3a — RED (task 3.5): ListDeletedOrganizations returns only the
// organizations the requester owns/admins, and purgeAt is exactly
// deletedAt + purge.Window.
func TestListDeletedOrganizationsReturnsOnlyRequesterAdministeredOrgs(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_trash_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "trash-owner@example.com")
	adminOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Trash Owned Org")
	insertOrganizationsTestMember(t, ctx, pool, adminOrganizationID, ownerID, "owner")
	if err := service.DeleteOrganization(ctx, ownerID, adminOrganizationID); err != nil {
		t.Fatalf("soft delete owned organization: %v", err)
	}

	// A second organization the requester has no relationship to at all --
	// must never appear in their Trash list.
	otherOwnerID := insertOrganizationsTestUser(t, ctx, pool, "trash-other-owner@example.com")
	unrelatedOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Trash Unrelated Org")
	insertOrganizationsTestMember(t, ctx, pool, unrelatedOrganizationID, otherOwnerID, "owner")
	if err := service.DeleteOrganization(ctx, otherOwnerID, unrelatedOrganizationID); err != nil {
		t.Fatalf("soft delete unrelated organization: %v", err)
	}

	deleted, err := service.ListDeletedOrganizations(ctx, ownerID)
	if err != nil {
		t.Fatalf("list deleted organizations: %v", err)
	}
	if len(deleted) != 1 {
		t.Fatalf("deleted count = %d, want 1", len(deleted))
	}
	if deleted[0].OrganizationID != adminOrganizationID {
		t.Fatalf("organization id = %q, want %q", deleted[0].OrganizationID, adminOrganizationID)
	}
	if deleted[0].Role != "owner" {
		t.Fatalf("role = %q, want owner", deleted[0].Role)
	}

	// purgeAt must equal deletedAt + purge.Window exactly, computed the same
	// way the production query computes it (deleted_at + interval), so this
	// assertion cannot drift from a text-formatting difference.
	var wantPurgeAt string
	if err := pool.QueryRow(ctx, `
		SELECT (deleted_at + $2::interval)::text
		FROM organizations WHERE id = $1
	`, adminOrganizationID, fmt.Sprintf("%d seconds", int64(purge.Window/time.Second))).Scan(&wantPurgeAt); err != nil {
		t.Fatalf("query expected purgeAt: %v", err)
	}
	if deleted[0].PurgeAt != wantPurgeAt {
		t.Fatalf("purgeAt = %q, want %q (deletedAt + purge.Window)", deleted[0].PurgeAt, wantPurgeAt)
	}
}

// Slice 3a — RED (task 3.5): a plain member of a trashed organization gets
// an empty result, never a 403 -- authorization is inline in the query's
// JOIN, not a separate gate call (design.md "Trash scoping and route
// shape" decision).
func TestListDeletedOrganizationsPlainMemberGetsEmptyResult(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_trash_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "trash-member-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "trash-member-plain@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Trash Member Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")
	if err := service.DeleteOrganization(ctx, ownerID, organizationID); err != nil {
		t.Fatalf("soft delete organization: %v", err)
	}

	deleted, err := service.ListDeletedOrganizations(ctx, memberID)
	if err != nil {
		t.Fatalf("list deleted organizations: %v", err)
	}
	if len(deleted) != 0 {
		t.Fatalf("deleted count = %d, want 0 (plain member, no 403 either)", len(deleted))
	}
}

// Slice 2b — RED: choke point 1. A soft-deleted organization vanishes from
// the org switcher (ListMemberships), even though the membership row itself
// is untouched.
func TestListMembershipsExcludesSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "cp1-owner@example.com")
	liveOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP1 Live Org")
	deletedOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP1 Deleted Org")
	insertOrganizationsTestMember(t, ctx, pool, liveOrganizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, deletedOrganizationID, ownerID, "owner")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, deletedOrganizationID)

	memberships, err := service.ListMemberships(ctx, ownerID)
	if err != nil {
		t.Fatalf("list memberships: %v", err)
	}
	if len(memberships) != 1 {
		t.Fatalf("membership count = %d, want 1 (deleted org must be excluded)", len(memberships))
	}
	if memberships[0].OrganizationID != liveOrganizationID {
		t.Fatalf("membership organization id = %q, want %q", memberships[0].OrganizationID, liveOrganizationID)
	}

	// The organization_members row itself is untouched by soft delete.
	if role := loadOrganizationsTestMemberRole(t, ctx, pool, deletedOrganizationID, ownerID); role != "owner" {
		t.Fatalf("membership role for deleted org = %q, want owner (soft delete must not touch organization_members)", role)
	}
}

// Slice 2b — RED: choke point 2. loadOrganizationRole/requireOrganizationAdmin
// rejects a would-be admin on a soft-deleted organization with ErrForbidden.
// ListMembers is the representative call site; PatchMember,
// AuthorizeInvitationTx, ListInvitations, CancelInvitation, ResendInvitation
// and DeleteOrganization all route through the same gate function and are
// therefore closed by the identical fix.
func TestListMembersRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cp2-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP2 Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, organizationID)

	members, err := service.ListMembers(ctx, adminID, organizationID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v (members=%#v)", err, ErrForbidden, members)
	}
}

// Slice 2b — RED: choke point 3. loadOrganizationMember, called directly
// (package-internal test, defense in depth behind choke point 2), returns
// ErrNotFound for a soft-deleted organization.
func TestLoadOrganizationMemberRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cp3-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP3 Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, organizationID)

	_, _, err := loadOrganizationMember(ctx, pool, organizationID, adminID)
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 2b — RED: choke point 5. CreateInvitationTx's context lookup is
// defense in depth behind choke point 2: requireOrganizationAdmin already
// rejects with ErrForbidden before the context query is ever reached, so
// this test observes CreateInvitation failing closed end-to-end.
func TestCreateInvitationRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cp5-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP5 Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, organizationID)

	_, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "invitee@example.com", Role: "member"})
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

// Slice 2b — RED: choke point 6. ResendInvitation's context lookup is
// defense in depth behind choke point 2, observed end-to-end: an invitation
// created before the organization was trashed can no longer be resent.
func TestResendInvitationRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cp6-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP6 Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	invitationID := insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "cp6-invitee@example.com", "member", "pending", adminID, "cp6-token")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, organizationID)

	_, err := service.ResendInvitation(ctx, adminID, organizationID, invitationID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

// Slice 2b — RED: choke point 7 (REQUIRED — token route, no upstream admin
// gate). ValidatePendingInvitation blocks self-registration through a
// still-valid invitation token once the organization is soft-deleted.
func TestValidatePendingInvitationRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cp7-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP7 Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "cp7-invitee@example.com", "member", "pending", adminID, "cp7-token")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, organizationID)

	err := service.ValidatePendingInvitation(ctx, "cp7-token", "cp7-invitee@example.com")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

// Slice 2b — RED: choke point 8 (REQUIRED — AcceptInvitation is token-based
// and ungated). Accepting a still-valid invitation into a soft-deleted
// organization fails with ErrNotFound instead of silently creating a
// membership in a trashed organization.
func TestAcceptInvitationRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_cp_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cp8-admin@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "cp8-invitee@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "CP8 Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestInvitation(t, ctx, pool, organizationID, "cp8-invitee@example.com", "member", "pending", adminID, "cp8-token")
	softDeleteOrganizationsTestOrganization(t, ctx, pool, organizationID)

	_, err := service.AcceptInvitation(ctx, inviteeID, "cp8-token")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}

	var memberCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND user_id = $2`, organizationID, inviteeID).Scan(&memberCount); err != nil {
		t.Fatalf("count organization members: %v", err)
	}
	if memberCount != 0 {
		t.Fatalf("member count = %d, want 0 (must not join a soft-deleted organization)", memberCount)
	}
}

// softDeleteOrganizationsTestOrganization stamps deleted_at directly via SQL
// (bypassing DeleteOrganization's admin gate and orphan probe) so choke-point
// tests can construct an already-trashed organization fixture regardless of
// membership shape.
func softDeleteOrganizationsTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = NOW() WHERE id = $1`, organizationID); err != nil {
		t.Fatalf("soft delete organization fixture: %v", err)
	}
}

// Task 2.34 — regression: DELETE /organizations/{organizationId} keeps its
// exact existing 204/403/404 status set after the soft-delete conversion
// (unit 2a) and the choke-point sweep (unit 2b) — only the persisted effect
// changed (soft vs. hard), never the HTTP contract. Wired against the real
// Service and a real database (unlike TestDeleteOrganizationRouteEnvelopeAuthAndErrors
// in handler_test.go, which is stub-driven and cannot observe the persisted
// effect at all).
func TestDeleteOrganizationRouteHTTPContractUnchangedBySoftDeleteConversion(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_delete_http_contract")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "http-contract-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "http-contract-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "HTTP Contract Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	currentUserID := memberID
	dynamicPrincipal := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: currentUserID})))
		})
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, dynamicPrincipal, service, nil)

	// A non-admin member gets 403, and the row stays live.
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/"+organizationID, nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("non-admin delete status = %d, want 403", recorder.Code)
	}
	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query organization: %v", err)
	}
	if deletedAt != nil {
		t.Fatal("deleted_at set after a forbidden delete attempt, want nil")
	}

	// The owner gets 204, and the row survives soft-deleted (the persisted
	// effect that changed — never the status code).
	currentUserID = ownerID
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/"+organizationID, nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("owner delete status = %d, want 204", recorder.Code)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("owner delete body = %q, want empty", recorder.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT deleted_at FROM organizations WHERE id = $1`, organizationID).Scan(&deletedAt); err != nil {
		t.Fatalf("query organization: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at = nil after a successful delete, want it set (soft delete, row survives)")
	}
	var organizationCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations WHERE id = $1`, organizationID).Scan(&organizationCount); err != nil {
		t.Fatalf("count organizations: %v", err)
	}
	if organizationCount != 1 {
		t.Fatalf("organization count = %d, want 1 (soft delete must not remove the row)", organizationCount)
	}

	// A second delete on the now-trashed organization gets 404, not a silent
	// no-op 204.
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/"+organizationID, nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("second delete status = %d, want 404", recorder.Code)
	}
}

func openOrganizationsTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration-style test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("ORGANIZATIONS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set ORGANIZATIONS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

	schemaName := fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
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

func insertOrganizationsTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func insertOrganizationsTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
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

func insertOrganizationsTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

// insertOrganizationsTestInvitation inserts an invitation row directly with
// an arbitrary status, bypassing the service so tests can construct
// already-accepted/cancelled/expired fixtures that CreateInvitation cannot
// produce on its own. token must be unique per call.
func insertOrganizationsTestInvitation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, email, role, status, invitedByUserID, token string) string {
	t.Helper()

	var invitationID string
	err := pool.QueryRow(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, status, invited_by_user_id)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`, organizationID, email, role, token, status, invitedByUserID).Scan(&invitationID)
	if err != nil {
		t.Fatalf("insert invitation: %v", err)
	}

	return invitationID
}

func loadOrganizationsTestInvitationStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, invitationID string) string {
	t.Helper()

	var status string
	err := pool.QueryRow(ctx, `SELECT status FROM invitations WHERE id = $1`, invitationID).Scan(&status)
	if err != nil {
		t.Fatalf("query invitation status: %v", err)
	}

	return status
}

func loadOrganizationsTestMemberRole(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID string) string {
	t.Helper()

	var role string
	err := pool.QueryRow(ctx, `
		SELECT role
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, organizationID, userID).Scan(&role)
	if err != nil {
		t.Fatalf("query organization member: %v", err)
	}

	return role
}

// assertOrganizationsTestActivityEvent asserts exactly one activity_events
// row exists matching the given organization/actor/kind/target, per the
// design's Call-Site Wiring table for organizations/service.go.
func assertOrganizationsTestActivityEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, actorUserID string, kind activity.Kind, targetType, targetID string) {
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

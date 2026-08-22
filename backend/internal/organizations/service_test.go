package organizations

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
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

// Phase 4 (Slice 4) — RED: happy path removes the organization and every
// cascading child row (members, workspaces + children, invitations, groups +
// children), while another organization's activity_events rows are left
// untouched, and no activity row is recorded for the delete itself.
func TestDeleteOrganizationHappyPathRemovesCascadesAndLeavesOtherOrgIntact(t *testing.T) {
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

	for table, condition := range map[string]string{
		"organizations":        "id = '" + organizationID + "'",
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
		if count != 0 {
			t.Fatalf("%s count = %d, want 0 after cascade delete", table, count)
		}
	}

	var otherActivityCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activity_events WHERE organization_id = $1`, otherOrganizationID).Scan(&otherActivityCount); err != nil {
		t.Fatalf("count other org activity events: %v", err)
	}
	if otherActivityCount == 0 {
		t.Fatal("other organization's activity_events rows must remain intact")
	}

	var totalActivityCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM activity_events`).Scan(&totalActivityCount); err != nil {
		t.Fatalf("count all activity events: %v", err)
	}
	if totalActivityCount != otherActivityCount {
		t.Fatalf("total activity event count = %d, want exactly %d (no delete-organization event recorded anywhere)", totalActivityCount, otherActivityCount)
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

	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations WHERE id = $1`, organizationID).Scan(&count); err != nil {
		t.Fatalf("count organizations: %v", err)
	}
	if count != 0 {
		t.Fatalf("organization count = %d, want 0", count)
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
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations WHERE id = $1`, organizationID).Scan(&count); err != nil {
		t.Fatalf("count organizations: %v", err)
	}
	if count != 0 {
		t.Fatalf("organization count = %d, want 0", count)
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

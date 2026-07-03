package organizations

import (
	"testing"
	"time"
)

func TestAcceptInvitationActivatesMembershipAndRejectsReuse(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invites_test")
	service := NewService(pool)
	inviterID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "invitee@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Invite Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "admin")

	invitation, err := service.CreateInvitation(ctx, inviterID, organizationID, CreateInvitationInput{
		Email: "invitee@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	accepted, err := service.AcceptInvitation(ctx, inviteeID, invitation.Token)
	if err != nil {
		t.Fatalf("accept invitation: %v", err)
	}
	if accepted.OrganizationID != organizationID {
		t.Fatalf("organization id = %q, want %q", accepted.OrganizationID, organizationID)
	}
	if accepted.Role != "member" {
		t.Fatalf("role = %q, want member", accepted.Role)
	}

	memberRole := loadOrganizationsTestMemberRole(t, ctx, pool, organizationID, inviteeID)
	if memberRole != "member" {
		t.Fatalf("member role = %q, want member", memberRole)
	}

	reused, err := service.AcceptInvitation(ctx, inviteeID, invitation.Token)
	if err == nil {
		t.Fatalf("expected second acceptance to fail, got %#v", reused)
	}
	if err != ErrInvitationNotPending {
		t.Fatalf("err = %v, want %v", err, ErrInvitationNotPending)
	}
}

func TestAcceptInvitationRejectsExpiredInvite(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invites_test")
	service := NewService(pool)
	inviterID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "invitee@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Invite Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "admin")

	invitation, err := service.CreateInvitation(ctx, inviterID, organizationID, CreateInvitationInput{
		Email: "invitee@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		UPDATE invitations
		SET expires_at = $2
		WHERE id = $1
	`, invitation.ID, time.Now().UTC().Add(-time.Minute)); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}

	accepted, err := service.AcceptInvitation(ctx, inviteeID, invitation.Token)
	if err == nil {
		t.Fatalf("expected expired invitation acceptance to fail, got %#v", accepted)
	}
	if err != ErrInvitationNotPending {
		t.Fatalf("err = %v, want %v", err, ErrInvitationNotPending)
	}

	var membershipCount int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, organizationID, inviteeID).Scan(&membershipCount); err != nil {
		t.Fatalf("count invitee memberships: %v", err)
	}
	if membershipCount != 0 {
		t.Fatalf("membership count = %d, want 0", membershipCount)
	}
}

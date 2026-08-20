package organizations

import (
	"testing"
	"time"
)

func TestListInvitationsReturnsPendingInvitationsForAdminsOnly(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invites_test")
	service := NewService(pool)
	adminID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "invitee@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Invite Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	pendingInvitation, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "pending@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create pending invitation: %v", err)
	}

	acceptedInvitation, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "invitee@example.com",
		Role:  "admin",
	})
	if err != nil {
		t.Fatalf("create accepted invitation: %v", err)
	}
	if _, err := service.AcceptInvitation(ctx, inviteeID, acceptedInvitation.Invitation.Token); err != nil {
		t.Fatalf("accept invitation: %v", err)
	}

	invitations, err := service.ListInvitations(ctx, adminID, organizationID)
	if err != nil {
		t.Fatalf("list invitations: %v", err)
	}
	if len(invitations) != 1 {
		t.Fatalf("invitation count = %d, want 1", len(invitations))
	}
	if invitations[0].ID != pendingInvitation.Invitation.ID {
		t.Fatalf("listed invitation id = %q, want %q", invitations[0].ID, pendingInvitation.Invitation.ID)
	}
	if invitations[0].Status != "pending" {
		t.Fatalf("listed invitation status = %q, want pending", invitations[0].Status)
	}
	if invitations[0].Email != "pending@example.com" {
		t.Fatalf("listed invitation email = %q, want pending@example.com", invitations[0].Email)
	}
}

func TestListInvitationsRejectsNonAdmins(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invites_test")
	service := NewService(pool)
	adminID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Invite Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	if _, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "pending@example.com",
		Role:  "member",
	}); err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	invitations, err := service.ListInvitations(ctx, memberID, organizationID)
	if err == nil {
		t.Fatalf("expected non-admin list invitations to fail, got %#v", invitations)
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

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

	accepted, err := service.AcceptInvitation(ctx, inviteeID, invitation.Invitation.Token)
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

	reused, err := service.AcceptInvitation(ctx, inviteeID, invitation.Invitation.Token)
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
	`, invitation.Invitation.ID, time.Now().UTC().Add(-time.Minute)); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}

	accepted, err := service.AcceptInvitation(ctx, inviteeID, invitation.Invitation.Token)
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

// Phase 9: Invitation Resend — RED: resend refreshes expires_at, keeps the
// same token, and updates the inviter context to the resending admin.
func TestResendInvitationRefreshesExpiryButKeepsToken(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_resend_test")
	service := NewService(pool)
	inviterID := insertOrganizationsTestUser(t, ctx, pool, "inviter@example.com")
	resenderID := insertOrganizationsTestUser(t, ctx, pool, "resender@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, resenderID, "owner")

	created, err := service.CreateInvitation(ctx, inviterID, organizationID, CreateInvitationInput{
		Email: "invitee@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	// Force the original expiry into the past so the refresh is unambiguous.
	pastExpiry := time.Now().UTC().Add(-time.Minute)
	if _, err := pool.Exec(ctx, `UPDATE invitations SET expires_at = $2 WHERE id = $1`, created.Invitation.ID, pastExpiry); err != nil {
		t.Fatalf("force past expiry: %v", err)
	}

	resent, err := service.ResendInvitation(ctx, resenderID, organizationID, created.Invitation.ID)
	if err != nil {
		t.Fatalf("resend invitation: %v", err)
	}
	if resent.Invitation.ID != created.Invitation.ID {
		t.Fatalf("resent id = %q, want %q", resent.Invitation.ID, created.Invitation.ID)
	}
	if resent.Invitation.Token != created.Invitation.Token {
		t.Fatalf("resent token = %q, want unchanged %q", resent.Invitation.Token, created.Invitation.Token)
	}
	if resent.Invitation.ExpiresAt == nil || *resent.Invitation.ExpiresAt == "" {
		t.Fatalf("resent expiresAt = %v, want a value", resent.Invitation.ExpiresAt)
	}
	if !resent.ExpiresAt.After(time.Now().UTC()) {
		t.Fatalf("resent ExpiresAt = %v, want it refreshed into the future", resent.ExpiresAt)
	}
	if resent.InviterEmail != "resender@example.com" {
		t.Fatalf("resent InviterEmail = %q, want the resending admin's email", resent.InviterEmail)
	}
}

// Phase 9: Invitation Resend — RED: resend is rejected once the invitation
// is no longer pending (accepted here; expired-and-swept is covered at the
// handler layer).
func TestResendInvitationRejectsNonPending(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_resend_test")
	service := NewService(pool)
	inviterID := insertOrganizationsTestUser(t, ctx, pool, "inviter2@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "invitee2@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Org 2")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "admin")

	created, err := service.CreateInvitation(ctx, inviterID, organizationID, CreateInvitationInput{
		Email: "invitee2@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if _, err := service.AcceptInvitation(ctx, inviteeID, created.Invitation.Token); err != nil {
		t.Fatalf("accept invitation: %v", err)
	}

	if _, err := service.ResendInvitation(ctx, inviterID, organizationID, created.Invitation.ID); err != ErrInvitationNotPending {
		t.Fatalf("err = %v, want %v", err, ErrInvitationNotPending)
	}
}

// Phase 9: Invitation Resend — RED: resend requires org admin/owner auth.
func TestResendInvitationRejectsNonAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_resend_test")
	service := NewService(pool)
	inviterID := insertOrganizationsTestUser(t, ctx, pool, "inviter3@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "member3@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Org 3")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	created, err := service.CreateInvitation(ctx, inviterID, organizationID, CreateInvitationInput{
		Email: "invitee3@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	if _, err := service.ResendInvitation(ctx, memberID, organizationID, created.Invitation.ID); err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

// Phase 9: Invitation Resend — RED: an invitation ID from a different
// organization is treated as not found, not leaked cross-tenant.
func TestResendInvitationNotFoundForWrongOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_resend_test")
	service := NewService(pool)
	inviterID := insertOrganizationsTestUser(t, ctx, pool, "inviter4@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Org 4")
	otherOrganizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Org 4 Other")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, otherOrganizationID, inviterID, "admin")

	created, err := service.CreateInvitation(ctx, inviterID, organizationID, CreateInvitationInput{
		Email: "invitee4@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	if _, err := service.ResendInvitation(ctx, inviterID, otherOrganizationID, created.Invitation.ID); err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

package organizations

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden               = errors.New("forbidden")
	ErrNotFound                = errors.New("not found")
	ErrLastOwner               = errors.New("last owner cannot be removed or demoted")
	ErrInvalidInvitationEmail  = errors.New("invalid_invitation_email")
	ErrInvitationMemberExists  = errors.New("invitation_member_exists")
	ErrInvitationPendingExists = errors.New("invitation_pending_exists")
	ErrInvitationNotPending    = errors.New("invitation is not pending")
	ErrInvitationEmailMismatch = errors.New("invitation email does not match authenticated user")
	ErrWouldOrphanMember       = errors.New("deleting this organization would leave a member with no organization")
)

type dbQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type Service struct {
	pool     *pgxpool.Pool
	activity *activity.Service
}

type Membership struct {
	OrganizationID   string `json:"organizationId"`
	OrganizationName string `json:"organizationName"`
	Role             string `json:"role"`
}

type CreateOrganizationInput struct {
	Name string `json:"name"`
}

type OrganizationMember struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name,omitempty"`
	Role   string `json:"role"`
}

type PatchMemberInput struct {
	UserID string  `json:"userId"`
	Role   *string `json:"role,omitempty"`
	Remove bool    `json:"remove,omitempty"`
}

type CreateInvitationInput struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

type Invitation struct {
	ID               string  `json:"id"`
	OrganizationID   string  `json:"organizationId"`
	Email            string  `json:"email"`
	Role             string  `json:"role"`
	Status           string  `json:"status"`
	Token            string  `json:"token"`
	InvitedByUserID  string  `json:"invitedByUserId"`
	AcceptedByUserID *string `json:"acceptedByUserId,omitempty"`
	ExpiresAt        *string `json:"expiresAt,omitempty"`
	AcceptedAt       *string `json:"acceptedAt,omitempty"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

type PendingInvitation struct {
	ID              string  `json:"id"`
	OrganizationID  string  `json:"organizationId"`
	Email           string  `json:"email"`
	Role            string  `json:"role"`
	Status          string  `json:"status"`
	InvitedByUserID string  `json:"invitedByUserId"`
	ExpiresAt       *string `json:"expiresAt,omitempty"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

type AcceptedInvitation struct {
	OrganizationID   string `json:"organizationId"`
	OrganizationName string `json:"organizationName"`
	Role             string `json:"role"`
}

// invitationTTL is D1: a fixed 7-day expiry, no env knob, no migration.
const invitationTTL = 168 * time.Hour

// InvitationCreation carries the created invitation plus the organization and
// inviter context needed to compose the invitation email, without widening
// Invitation's own serialized JSON shape.
type InvitationCreation struct {
	Invitation       Invitation
	OrganizationName string
	InviterEmail     string
	InviterName      string
	ExpiresAt        time.Time
}

type invitationRecord struct {
	ID               string
	OrganizationID   string
	OrganizationName string
	Email            string
	Role             access.OrganizationRole
	Status           string
	ExpiresAt        *time.Time
	AcceptedByUserID *string
	AcceptedAt       *string
	CreatedAt        string
	UpdatedAt        string
}

func NewService(pool *pgxpool.Pool, activityService *activity.Service) *Service {
	return &Service{pool: pool, activity: activityService}
}

func (s *Service) ListMemberships(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.id, o.name, om.role
		FROM organization_members om
		JOIN organizations o ON o.id = om.organization_id
		WHERE om.user_id = $1
		ORDER BY o.name, o.id
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("query organizations: %w", err)
	}
	defer rows.Close()

	memberships := make([]Membership, 0)
	for rows.Next() {
		var membership Membership
		if err := rows.Scan(&membership.OrganizationID, &membership.OrganizationName, &membership.Role); err != nil {
			return nil, fmt.Errorf("scan organization membership: %w", err)
		}
		memberships = append(memberships, membership)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate organizations: %w", err)
	}

	return memberships, nil
}

func (s *Service) CreateOrganization(ctx context.Context, userID string, input CreateOrganizationInput) (Membership, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Membership{}, fmt.Errorf("begin create organization tx: %w", err)
	}
	defer tx.Rollback(ctx)
	membership, err := s.CreateOrganizationTx(ctx, tx, userID, input)
	if err != nil {
		return Membership{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Membership{}, fmt.Errorf("commit create organization tx: %w", err)
	}
	return membership, nil
}

func (s *Service) CreateOrganizationTx(ctx context.Context, tx pgx.Tx, userID string, input CreateOrganizationInput) (Membership, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return Membership{}, fmt.Errorf("organization name is required")
	}

	var membership Membership
	err := tx.QueryRow(ctx, `
		WITH new_org AS (
			INSERT INTO organizations (name)
			VALUES ($1)
			RETURNING id, name
		), new_member AS (
			INSERT INTO organization_members (organization_id, user_id, role)
			SELECT id, $2, $3 FROM new_org
			RETURNING organization_id, role
		)
		SELECT new_org.id, new_org.name, new_member.role
		FROM new_org
		JOIN new_member ON new_member.organization_id = new_org.id
	`, name, userID, access.OrganizationRoleOwner).Scan(
		&membership.OrganizationID,
		&membership.OrganizationName,
		&membership.Role,
	)
	if err != nil {
		return Membership{}, fmt.Errorf("create organization: %w", err)
	}

	if err := s.activity.Record(ctx, tx, membership.OrganizationID, userID, activity.KindOrganizationCreated, "organization", membership.OrganizationID, map[string]any{
		"organizationName": membership.OrganizationName,
	}); err != nil {
		return Membership{}, fmt.Errorf("record organization created activity: %w", err)
	}

	return membership, nil
}

func (s *Service) AuthorizeOrganizationCreationTx(ctx context.Context, tx pgx.Tx, userID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists); err != nil {
		return fmt.Errorf("authorize organization creation: %w", err)
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

func (s *Service) ListMembers(ctx context.Context, requesterUserID, organizationID string) ([]OrganizationMember, error) {
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT u.id, u.email, COALESCE(u.name, ''), om.role
		FROM organization_members om
		JOIN users u ON u.id = om.user_id
		WHERE om.organization_id = $1
		ORDER BY CASE om.role
			WHEN 'owner' THEN 1
			WHEN 'admin' THEN 2
			ELSE 3
		END, u.email, u.id
	`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("query organization members: %w", err)
	}
	defer rows.Close()

	members := make([]OrganizationMember, 0)
	for rows.Next() {
		var member OrganizationMember
		if err := rows.Scan(&member.UserID, &member.Email, &member.Name, &member.Role); err != nil {
			return nil, fmt.Errorf("scan organization member: %w", err)
		}
		members = append(members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate organization members: %w", err)
	}

	return members, nil
}

func (s *Service) PatchMember(ctx context.Context, requesterUserID, organizationID string, input PatchMemberInput) (OrganizationMember, error) {
	userID := strings.TrimSpace(input.UserID)
	if userID == "" {
		return OrganizationMember{}, fmt.Errorf("userId is required")
	}
	if input.Remove && input.Role != nil {
		return OrganizationMember{}, fmt.Errorf("role cannot be set when remove is true")
	}
	if !input.Remove && input.Role == nil {
		return OrganizationMember{}, fmt.Errorf("role is required when remove is false")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OrganizationMember{}, fmt.Errorf("begin patch member tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := lockOrganization(ctx, tx, organizationID); err != nil {
		return OrganizationMember{}, err
	}
	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return OrganizationMember{}, err
	}
	if err := lockOrganizationMemberships(ctx, tx, organizationID); err != nil {
		return OrganizationMember{}, err
	}

	currentMember, currentRole, err := loadOrganizationMember(ctx, tx, organizationID, userID)
	if err != nil {
		return OrganizationMember{}, err
	}

	if !input.Remove {
		nextRole, err := normalizeOrganizationRole(*input.Role)
		if err != nil {
			return OrganizationMember{}, err
		}
		if nextRole == access.OrganizationRoleOwner {
			requesterRole, err := loadOrganizationRole(ctx, tx, organizationID, requesterUserID)
			if err != nil {
				return OrganizationMember{}, err
			}
			if requesterRole != access.OrganizationRoleOwner {
				return OrganizationMember{}, ErrForbidden
			}
		}
	}

	if currentRole == access.OrganizationRoleOwner {
		remainingOwners, err := countOwners(ctx, tx, organizationID)
		if err != nil {
			return OrganizationMember{}, err
		}
		if remainingOwners == 1 {
			if input.Remove {
				return OrganizationMember{}, ErrLastOwner
			}
			nextRole, err := normalizeOrganizationRole(*input.Role)
			if err != nil {
				return OrganizationMember{}, err
			}
			if nextRole != access.OrganizationRoleOwner {
				return OrganizationMember{}, ErrLastOwner
			}
		}
	}

	if input.Remove {
		if _, err := tx.Exec(ctx, `
			DELETE FROM organization_members
			WHERE organization_id = $1 AND user_id = $2
		`, organizationID, userID); err != nil {
			return OrganizationMember{}, fmt.Errorf("delete organization member: %w", err)
		}
		if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindOrganizationMemberRemoved, "organization_member", userID, map[string]any{
			"targetEmail":  currentMember.Email,
			"previousRole": string(currentRole),
		}); err != nil {
			return OrganizationMember{}, fmt.Errorf("record organization member removed activity: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return OrganizationMember{}, fmt.Errorf("commit remove member tx: %w", err)
		}
		return currentMember, nil
	}

	nextRole, err := normalizeOrganizationRole(*input.Role)
	if err != nil {
		return OrganizationMember{}, err
	}

	updatedMember, err := updateOrganizationMemberRole(ctx, tx, organizationID, userID, nextRole)
	if err != nil {
		return OrganizationMember{}, err
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindOrganizationMemberRoleChanged, "organization_member", userID, map[string]any{
		"role":         string(nextRole),
		"previousRole": string(currentRole),
		"targetEmail":  currentMember.Email,
	}); err != nil {
		return OrganizationMember{}, fmt.Errorf("record organization member role changed activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return OrganizationMember{}, fmt.Errorf("commit patch member tx: %w", err)
	}

	return updatedMember, nil
}

func (s *Service) CreateInvitation(ctx context.Context, requesterUserID, organizationID string, input CreateInvitationInput) (InvitationCreation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InvitationCreation{}, fmt.Errorf("begin create invitation tx: %w", err)
	}
	defer tx.Rollback(ctx)
	created, err := s.CreateInvitationTx(ctx, tx, requesterUserID, organizationID, input)
	if err != nil {
		return InvitationCreation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return InvitationCreation{}, fmt.Errorf("commit create invitation tx: %w", err)
	}
	return created, nil
}

func (s *Service) CreateInvitationTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string, input CreateInvitationInput) (InvitationCreation, error) {
	email := strings.TrimSpace(strings.ToLower(input.Email))
	parsedEmail, err := mail.ParseAddress(email)
	if err != nil || parsedEmail.Address != email {
		return InvitationCreation{}, ErrInvalidInvitationEmail
	}
	role, err := normalizeOrganizationRole(input.Role)
	if err != nil {
		return InvitationCreation{}, err
	}
	token, err := generateInviteToken()
	if err != nil {
		return InvitationCreation{}, err
	}

	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return InvitationCreation{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE invitations
		SET status = 'expired', updated_at = NOW()
		WHERE organization_id = $1
			AND status = 'pending'
			AND expires_at IS NOT NULL
			AND expires_at <= NOW()
	`, organizationID); err != nil {
		return InvitationCreation{}, fmt.Errorf("expire pending invitations: %w", err)
	}

	var memberExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM organization_members om
			JOIN users u ON u.id = om.user_id
			WHERE om.organization_id = $1 AND lower(u.email) = $2
		)
	`, organizationID, email).Scan(&memberExists); err != nil {
		return InvitationCreation{}, fmt.Errorf("check invitation member: %w", err)
	}
	if memberExists {
		return InvitationCreation{}, ErrInvitationMemberExists
	}

	var pendingExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM invitations
			WHERE organization_id = $1 AND lower(email) = $2 AND status = 'pending'
		)
	`, organizationID, email).Scan(&pendingExists); err != nil {
		return InvitationCreation{}, fmt.Errorf("check pending invitation: %w", err)
	}
	if pendingExists {
		return InvitationCreation{}, ErrInvitationPendingExists
	}

	expiresAt := time.Now().UTC().Add(invitationTTL)

	var invitation Invitation
	err = tx.QueryRow(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, organization_id, email, role, status, token, invited_by_user_id,
			accepted_by_user_id, expires_at::text, accepted_at::text, created_at::text, updated_at::text
	`, organizationID, email, role, token, requesterUserID, expiresAt).Scan(
		&invitation.ID,
		&invitation.OrganizationID,
		&invitation.Email,
		&invitation.Role,
		&invitation.Status,
		&invitation.Token,
		&invitation.InvitedByUserID,
		&invitation.AcceptedByUserID,
		&invitation.ExpiresAt,
		&invitation.AcceptedAt,
		&invitation.CreatedAt,
		&invitation.UpdatedAt,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return InvitationCreation{}, ErrInvitationPendingExists
		}
		return InvitationCreation{}, fmt.Errorf("create invitation: %w", err)
	}

	var organizationName, inviterEmail, inviterName string
	err = tx.QueryRow(ctx, `
		SELECT o.name, u.email, COALESCE(NULLIF(TRIM(u.name), ''), '')
		FROM organizations o
		JOIN users u ON u.id = $2
		WHERE o.id = $1
	`, organizationID, requesterUserID).Scan(&organizationName, &inviterEmail, &inviterName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InvitationCreation{}, ErrNotFound
		}
		return InvitationCreation{}, fmt.Errorf("load invitation context: %w", err)
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindInvitationCreated, "invitation", invitation.ID, map[string]any{
		"email": invitation.Email,
		"role":  invitation.Role,
	}); err != nil {
		return InvitationCreation{}, fmt.Errorf("record invitation created activity: %w", err)
	}

	return InvitationCreation{
		Invitation:       invitation,
		OrganizationName: organizationName,
		InviterEmail:     inviterEmail,
		InviterName:      inviterName,
		ExpiresAt:        expiresAt,
	}, nil
}

// ResendInvitation refreshes a pending invitation's expiry and returns the
// same InvitationCreation shape as CreateInvitation so the caller can reuse
// the existing invitationNotifier machinery to re-send the email. Unlike
// CreateInvitationTx, this is not wired through ExecutePrepared/idempotency:
// resending twice by mistake only means an extra email, not a data-integrity
// problem, so a single begin/commit transaction is enough.
func (s *Service) ResendInvitation(ctx context.Context, requesterUserID, organizationID, invitationID string) (InvitationCreation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InvitationCreation{}, fmt.Errorf("begin resend invitation tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return InvitationCreation{}, err
	}

	var status string
	if err := tx.QueryRow(ctx, `
		SELECT status
		FROM invitations
		WHERE id = $1 AND organization_id = $2
		FOR UPDATE
	`, invitationID, organizationID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InvitationCreation{}, ErrNotFound
		}
		return InvitationCreation{}, fmt.Errorf("load invitation for resend: %w", err)
	}
	if status != "pending" {
		return InvitationCreation{}, ErrInvitationNotPending
	}

	expiresAt := time.Now().UTC().Add(invitationTTL)

	var invitation Invitation
	err = tx.QueryRow(ctx, `
		UPDATE invitations
		SET expires_at = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, organization_id, email, role, status, token, invited_by_user_id,
			accepted_by_user_id, expires_at::text, accepted_at::text, created_at::text, updated_at::text
	`, invitationID, expiresAt).Scan(
		&invitation.ID,
		&invitation.OrganizationID,
		&invitation.Email,
		&invitation.Role,
		&invitation.Status,
		&invitation.Token,
		&invitation.InvitedByUserID,
		&invitation.AcceptedByUserID,
		&invitation.ExpiresAt,
		&invitation.AcceptedAt,
		&invitation.CreatedAt,
		&invitation.UpdatedAt,
	)
	if err != nil {
		return InvitationCreation{}, fmt.Errorf("resend invitation: %w", err)
	}

	var organizationName, inviterEmail, inviterName string
	err = tx.QueryRow(ctx, `
		SELECT o.name, u.email, COALESCE(NULLIF(TRIM(u.name), ''), '')
		FROM organizations o
		JOIN users u ON u.id = $2
		WHERE o.id = $1
	`, organizationID, requesterUserID).Scan(&organizationName, &inviterEmail, &inviterName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InvitationCreation{}, ErrNotFound
		}
		return InvitationCreation{}, fmt.Errorf("load resend invitation context: %w", err)
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindInvitationResent, "invitation", invitation.ID, map[string]any{
		"email": invitation.Email,
	}); err != nil {
		return InvitationCreation{}, fmt.Errorf("record invitation resent activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return InvitationCreation{}, fmt.Errorf("commit resend invitation tx: %w", err)
	}

	return InvitationCreation{
		Invitation:       invitation,
		OrganizationName: organizationName,
		InviterEmail:     inviterEmail,
		InviterName:      inviterName,
		ExpiresAt:        expiresAt,
	}, nil
}

// CancelInvitation transitions a pending invitation to cancelled, recording
// an invitation.cancelled activity row atomically with the status change.
// Modeled directly on ResendInvitation: admin-gate, lock the invitation row,
// guard on status, mutate, record, commit.
func (s *Service) CancelInvitation(ctx context.Context, requesterUserID, organizationID, invitationID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin cancel invitation tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return err
	}

	var status, email string
	if err := tx.QueryRow(ctx, `
		SELECT status, email
		FROM invitations
		WHERE id = $1 AND organization_id = $2
		FOR UPDATE
	`, invitationID, organizationID).Scan(&status, &email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load invitation for cancel: %w", err)
	}
	if status != "pending" {
		return ErrInvitationNotPending
	}

	if _, err := tx.Exec(ctx, `
		UPDATE invitations
		SET status = 'cancelled', updated_at = NOW()
		WHERE id = $1
	`, invitationID); err != nil {
		return fmt.Errorf("cancel invitation: %w", err)
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindInvitationCancelled, "invitation", invitationID, map[string]any{
		"email": email,
	}); err != nil {
		return fmt.Errorf("record invitation cancelled activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cancel invitation tx: %w", err)
	}

	return nil
}

// DeleteOrganization soft-deletes an organization after an admin gate and an
// orphan-member guard. Modeled on PatchMember's locking sequence:
// lockOrganization (FOR UPDATE on the org row) -> requireOrganizationAdmin ->
// lockOrganizationMemberships (FOR UPDATE on every membership row) -> the
// orphan probe -> soft-delete UPDATE. lockOrganization's FOR UPDATE also
// serializes concurrent DeleteOrganization calls against the same org: the
// losing transaction blocks until the winner commits, then lockOrganization's
// own `deleted_at IS NULL` predicate finds zero rows and returns ErrNotFound
// (see TestDeleteOrganizationConcurrentRequestsOnlyOneCommits).
//
// Soft delete (design.md "Migration DDL" / recovery window): the row is kept
// with deleted_at/deleted_by_user_id set, not removed. Nothing cascades, so
// an organization.deleted activity event is recorded inside this same
// transaction, before commit (design.md Deviation 3, reversing
// lifecycle-management's "record nothing" decision, which was correct only
// for the previous hard DELETE).
func (s *Service) DeleteOrganization(ctx context.Context, requesterUserID, organizationID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delete organization tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := lockOrganization(ctx, tx, organizationID); err != nil {
		return err
	}
	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return err
	}
	if err := lockOrganizationMemberships(ctx, tx, organizationID); err != nil {
		return err
	}

	wouldOrphan, err := organizationDeleteWouldOrphanMember(ctx, tx, organizationID, requesterUserID)
	if err != nil {
		return err
	}
	if wouldOrphan {
		return ErrWouldOrphanMember
	}

	var organizationName string
	if err := tx.QueryRow(ctx, `SELECT name FROM organizations WHERE id = $1`, organizationID).Scan(&organizationName); err != nil {
		return fmt.Errorf("load organization name for delete: %w", err)
	}

	result, err := tx.Exec(ctx, `
		UPDATE organizations
		SET deleted_at = NOW(), deleted_by_user_id = $2, updated_at = NOW()
		WHERE id = $1 AND deleted_at IS NULL
	`, organizationID, requesterUserID)
	if err != nil {
		return fmt.Errorf("soft delete organization: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindOrganizationDeleted, "organization", organizationID, map[string]any{
		"organizationName": organizationName,
	}); err != nil {
		return fmt.Errorf("record organization deleted activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delete organization tx: %w", err)
	}

	return nil
}

// organizationDeleteWouldOrphanMember runs after lockOrganization and
// lockOrganizationMemberships. It excludes the requester (om.user_id <> $2)
// per design.md's "Slice 4 requester exclusion" decision: a sole member
// deleting their own last organization is a deliberate self-service act, not
// an accidental orphan. The inner EXISTS against organizations (choke point
// 9 / design.md Deviation 5) excludes a member's other organization from
// counting as a fallback when that other organization is itself in the
// trash: a soft-deleted organization is not reachable, so it must not save a
// member from being orphaned.
func organizationDeleteWouldOrphanMember(ctx context.Context, tx pgx.Tx, organizationID, requesterUserID string) (bool, error) {
	var wouldOrphan bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM organization_members om
			WHERE om.organization_id = $1
				AND om.user_id <> $2
				AND NOT EXISTS (
					SELECT 1 FROM organization_members other
					WHERE other.user_id = om.user_id
						AND other.organization_id <> $1
						AND EXISTS (
							SELECT 1 FROM organizations o2
							WHERE o2.id = other.organization_id
								AND o2.deleted_at IS NULL
						)
				)
		)
	`, organizationID, requesterUserID).Scan(&wouldOrphan); err != nil {
		return false, fmt.Errorf("check organization delete orphan guard: %w", err)
	}
	return wouldOrphan, nil
}

func (s *Service) AuthorizeInvitationTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string) error {
	return requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID)
}

func (s *Service) ListInvitations(ctx context.Context, requesterUserID, organizationID string) ([]PendingInvitation, error) {
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, email, role, status, invited_by_user_id,
			expires_at::text, created_at::text, updated_at::text
		FROM invitations
		WHERE organization_id = $1
			AND (
				(status = 'pending' AND (expires_at IS NULL OR expires_at > NOW()))
				OR status = 'cancelled'
			)
		ORDER BY created_at DESC, id DESC
	`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("query invitations: %w", err)
	}
	defer rows.Close()

	invitations := make([]PendingInvitation, 0)
	for rows.Next() {
		var invitation PendingInvitation
		if err := rows.Scan(
			&invitation.ID,
			&invitation.OrganizationID,
			&invitation.Email,
			&invitation.Role,
			&invitation.Status,
			&invitation.InvitedByUserID,
			&invitation.ExpiresAt,
			&invitation.CreatedAt,
			&invitation.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan invitation: %w", err)
		}
		invitations = append(invitations, invitation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate invitations: %w", err)
	}

	return invitations, nil
}

func (s *Service) AcceptInvitation(ctx context.Context, userID, token string) (AcceptedInvitation, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return AcceptedInvitation{}, fmt.Errorf("invitation token is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("begin accept invitation tx: %w", err)
	}
	defer tx.Rollback(ctx)

	userEmail, err := loadUserEmail(ctx, tx, userID)
	if err != nil {
		return AcceptedInvitation{}, err
	}

	record, err := loadInvitationForUpdate(ctx, tx, token)
	if err != nil {
		return AcceptedInvitation{}, err
	}
	if record.Status != "pending" {
		return AcceptedInvitation{}, ErrInvitationNotPending
	}
	if record.ExpiresAt != nil && !record.ExpiresAt.After(time.Now().UTC()) {
		return AcceptedInvitation{}, ErrInvitationNotPending
	}
	if strings.TrimSpace(strings.ToLower(record.Email)) != userEmail {
		return AcceptedInvitation{}, ErrInvitationEmailMismatch
	}

	result, err := tx.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (organization_id, user_id) DO NOTHING
	`, record.OrganizationID, userID, record.Role)
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("create organization member from invitation: %w", err)
	}
	if result.RowsAffected() == 0 {
		return AcceptedInvitation{}, fmt.Errorf("user is already a member of organization")
	}

	if _, err := tx.Exec(ctx, `
		UPDATE invitations
		SET status = 'accepted',
			accepted_by_user_id = $2,
			accepted_at = NOW(),
			updated_at = NOW()
		WHERE id = $1
	`, record.ID, userID); err != nil {
		return AcceptedInvitation{}, fmt.Errorf("mark invitation accepted: %w", err)
	}

	if err := s.activity.Record(ctx, tx, record.OrganizationID, userID, activity.KindInvitationAccepted, "invitation", record.ID, map[string]any{
		"email": record.Email,
		"role":  string(record.Role),
	}); err != nil {
		return AcceptedInvitation{}, fmt.Errorf("record invitation accepted activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return AcceptedInvitation{}, fmt.Errorf("commit accept invitation tx: %w", err)
	}

	return AcceptedInvitation{
		OrganizationID:   record.OrganizationID,
		OrganizationName: record.OrganizationName,
		Role:             string(record.Role),
	}, nil
}

// ValidatePendingInvitation is a read-only counterpart to AcceptInvitation
// used to gate self-registration behind a real, pending, matching-email
// invitation without mutating any state. It intentionally does not lock the
// row (no FOR UPDATE) and does not require a transaction — callers must not
// use it to decide whether to mutate the invitation; only AcceptInvitation
// may transition an invitation to accepted.
func (s *Service) ValidatePendingInvitation(ctx context.Context, token, email string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return ErrNotFound
	}
	normalizedEmail := strings.TrimSpace(strings.ToLower(email))

	var record invitationRecord
	err := s.pool.QueryRow(ctx, `
		SELECT i.id, i.organization_id, o.name, i.email, i.role, i.status,
			i.expires_at, i.accepted_by_user_id, i.accepted_at::text, i.created_at::text, i.updated_at::text
		FROM invitations i
		JOIN organizations o ON o.id = i.organization_id
		WHERE i.token = $1
	`, token).Scan(
		&record.ID,
		&record.OrganizationID,
		&record.OrganizationName,
		&record.Email,
		&record.Role,
		&record.Status,
		&record.ExpiresAt,
		&record.AcceptedByUserID,
		&record.AcceptedAt,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("query invitation: %w", err)
	}

	if record.Status != "pending" {
		return ErrInvitationNotPending
	}
	if record.ExpiresAt != nil && !record.ExpiresAt.After(time.Now().UTC()) {
		return ErrInvitationNotPending
	}
	if strings.TrimSpace(strings.ToLower(record.Email)) != normalizedEmail {
		return ErrInvitationEmailMismatch
	}

	return nil
}

func requireOrganizationAdmin(ctx context.Context, querier dbQuerier, userID, organizationID string) error {
	role, err := loadOrganizationRole(ctx, querier, organizationID, userID)
	if err != nil {
		return err
	}
	if role != access.OrganizationRoleOwner && role != access.OrganizationRoleAdmin {
		return ErrForbidden
	}

	return nil
}

func loadOrganizationRole(ctx context.Context, querier dbQuerier, organizationID, userID string) (access.OrganizationRole, error) {
	var role string
	err := querier.QueryRow(ctx, `
		SELECT role
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, organizationID, userID).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrForbidden
		}
		return "", fmt.Errorf("query organization role: %w", err)
	}

	normalizedRole, err := normalizeOrganizationRole(role)
	if err != nil {
		return "", err
	}

	return normalizedRole, nil
}

func loadOrganizationMember(ctx context.Context, querier dbQuerier, organizationID, userID string) (OrganizationMember, access.OrganizationRole, error) {
	var member OrganizationMember
	var role string
	err := querier.QueryRow(ctx, `
		SELECT u.id, u.email, COALESCE(u.name, ''), om.role
		FROM organization_members om
		JOIN users u ON u.id = om.user_id
		WHERE om.organization_id = $1 AND om.user_id = $2
	`, organizationID, userID).Scan(&member.UserID, &member.Email, &member.Name, &role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OrganizationMember{}, "", ErrNotFound
		}
		return OrganizationMember{}, "", fmt.Errorf("query organization member: %w", err)
	}
	member.Role = role

	normalizedRole, err := normalizeOrganizationRole(role)
	if err != nil {
		return OrganizationMember{}, "", err
	}

	return member, normalizedRole, nil
}

func countOwners(ctx context.Context, querier dbQuerier, organizationID string) (int, error) {
	var count int
	err := querier.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM organization_members
		WHERE organization_id = $1 AND role = $2
	`, organizationID, access.OrganizationRoleOwner).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count organization owners: %w", err)
	}

	return count, nil
}

func lockOrganization(ctx context.Context, querier dbQuerier, organizationID string) error {
	var id string
	err := querier.QueryRow(ctx, `SELECT id FROM organizations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, organizationID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

func lockOrganizationMemberships(ctx context.Context, querier dbQuerier, organizationID string) error {
	rows, err := querier.Query(ctx, `SELECT user_id FROM organization_members WHERE organization_id = $1 FOR UPDATE`, organizationID)
	if err != nil {
		return fmt.Errorf("lock organization memberships: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return fmt.Errorf("scan locked organization member: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate locked organization members: %w", err)
	}
	return nil
}

func updateOrganizationMemberRole(ctx context.Context, querier dbQuerier, organizationID, userID string, role access.OrganizationRole) (OrganizationMember, error) {
	var member OrganizationMember
	err := querier.QueryRow(ctx, `
		UPDATE organization_members om
		SET role = $3
		FROM users u
		WHERE om.organization_id = $1 AND om.user_id = $2 AND u.id = om.user_id
		RETURNING u.id, u.email, COALESCE(u.name, ''), om.role
	`, organizationID, userID, role).Scan(&member.UserID, &member.Email, &member.Name, &member.Role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OrganizationMember{}, ErrNotFound
		}
		return OrganizationMember{}, fmt.Errorf("update organization member role: %w", err)
	}

	return member, nil
}

func loadUserEmail(ctx context.Context, querier dbQuerier, userID string) (string, error) {
	var email string
	err := querier.QueryRow(ctx, `
		SELECT email
		FROM users
		WHERE id = $1
	`, userID).Scan(&email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("query user email: %w", err)
	}

	return strings.TrimSpace(strings.ToLower(email)), nil
}

func loadInvitationForUpdate(ctx context.Context, querier dbQuerier, token string) (invitationRecord, error) {
	var record invitationRecord
	err := querier.QueryRow(ctx, `
		SELECT i.id, i.organization_id, o.name, i.email, i.role, i.status,
			i.expires_at, i.accepted_by_user_id, i.accepted_at::text, i.created_at::text, i.updated_at::text
		FROM invitations i
		JOIN organizations o ON o.id = i.organization_id
		WHERE i.token = $1
		FOR UPDATE
	`, token).Scan(
		&record.ID,
		&record.OrganizationID,
		&record.OrganizationName,
		&record.Email,
		&record.Role,
		&record.Status,
		&record.ExpiresAt,
		&record.AcceptedByUserID,
		&record.AcceptedAt,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return invitationRecord{}, ErrNotFound
		}
		return invitationRecord{}, fmt.Errorf("query invitation: %w", err)
	}

	return record, nil
}

func normalizeOrganizationRole(raw string) (access.OrganizationRole, error) {
	switch access.OrganizationRole(strings.TrimSpace(strings.ToLower(raw))) {
	case access.OrganizationRoleOwner:
		return access.OrganizationRoleOwner, nil
	case access.OrganizationRoleAdmin:
		return access.OrganizationRoleAdmin, nil
	case access.OrganizationRoleMember:
		return access.OrganizationRoleMember, nil
	default:
		return "", fmt.Errorf("unsupported organization role %q", raw)
	}
}

func generateInviteToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate invite token: %w", err)
	}

	return hex.EncodeToString(buffer), nil
}

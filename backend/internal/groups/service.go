package groups

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden = errors.New("forbidden")
	ErrNotFound  = errors.New("not found")
)

type dbQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type Service struct {
	pool *pgxpool.Pool
}

type Group struct {
	ID             string `json:"id"`
	OrganizationID string `json:"organizationId"`
	Name           string `json:"name"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type GroupMember struct {
	GroupID string `json:"groupId"`
	UserID  string `json:"userId"`
	Email   string `json:"email"`
	Name    string `json:"name,omitempty"`
}

type CreateGroupInput struct {
	Name string `json:"name"`
}

type UpdateGroupInput struct {
	Name string `json:"name"`
}

type AddGroupMemberInput struct {
	UserID string `json:"userId"`
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) List(ctx context.Context, requesterUserID, organizationID string) ([]Group, error) {
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, name, created_at::text, updated_at::text
		FROM groups
		WHERE organization_id = $1
		ORDER BY name, id
	`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("query groups: %w", err)
	}
	defer rows.Close()

	groups := make([]Group, 0)
	for rows.Next() {
		var group Group
		if err := rows.Scan(&group.ID, &group.OrganizationID, &group.Name, &group.CreatedAt, &group.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan group: %w", err)
		}
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate groups: %w", err)
	}

	return groups, nil
}

func (s *Service) Create(ctx context.Context, requesterUserID, organizationID string, input CreateGroupInput) (Group, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Group{}, fmt.Errorf("begin create group tx: %w", err)
	}
	defer tx.Rollback(ctx)
	group, err := s.CreateTx(ctx, tx, requesterUserID, organizationID, input)
	if err != nil {
		return Group{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Group{}, fmt.Errorf("commit create group tx: %w", err)
	}
	return group, nil
}

func (s *Service) CreateTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string, input CreateGroupInput) (Group, error) {
	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return Group{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return Group{}, fmt.Errorf("group name is required")
	}
	var group Group
	err := tx.QueryRow(ctx, `
		INSERT INTO groups (organization_id, name)
		VALUES ($1, $2)
		RETURNING id, organization_id, name, created_at::text, updated_at::text
	`, organizationID, name).Scan(&group.ID, &group.OrganizationID, &group.Name, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return Group{}, fmt.Errorf("create group: %w", err)
	}

	return group, nil
}

func (s *Service) AuthorizeCreateTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string) error {
	return requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID)
}

func (s *Service) Update(ctx context.Context, requesterUserID, organizationID, groupID string, input UpdateGroupInput) (Group, error) {
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return Group{}, err
	}

	name := strings.TrimSpace(input.Name)
	if name == "" {
		return Group{}, fmt.Errorf("group name is required")
	}

	var group Group
	err := s.pool.QueryRow(ctx, `
		UPDATE groups
		SET name = $3, updated_at = NOW()
		WHERE id = $1 AND organization_id = $2
		RETURNING id, organization_id, name, created_at::text, updated_at::text
	`, groupID, organizationID, name).Scan(&group.ID, &group.OrganizationID, &group.Name, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Group{}, ErrNotFound
		}
		return Group{}, fmt.Errorf("update group: %w", err)
	}

	return group, nil
}

func (s *Service) Delete(ctx context.Context, requesterUserID, organizationID, groupID string) error {
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return err
	}

	result, err := s.pool.Exec(ctx, `
		DELETE FROM groups
		WHERE id = $1 AND organization_id = $2
	`, groupID, organizationID)
	if err != nil {
		return fmt.Errorf("delete group: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}

	return nil
}

func (s *Service) AddMember(ctx context.Context, requesterUserID, groupID string, input AddGroupMemberInput) (GroupMember, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return GroupMember{}, fmt.Errorf("begin add group member tx: %w", err)
	}
	defer tx.Rollback(ctx)
	member, err := s.AddMemberTx(ctx, tx, requesterUserID, groupID, input)
	if err != nil {
		return GroupMember{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return GroupMember{}, fmt.Errorf("commit add group member tx: %w", err)
	}
	return member, nil
}

func (s *Service) AddMemberTx(ctx context.Context, tx pgx.Tx, requesterUserID, groupID string, input AddGroupMemberInput) (GroupMember, error) {
	userID := strings.TrimSpace(input.UserID)
	if userID == "" {
		return GroupMember{}, fmt.Errorf("userId is required")
	}

	organizationID, err := loadGroupOrganizationID(ctx, tx, groupID)
	if err != nil {
		return GroupMember{}, err
	}
	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return GroupMember{}, err
	}
	if err := requireOrganizationMembership(ctx, tx, organizationID, userID); err != nil {
		return GroupMember{}, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2)
		ON CONFLICT (group_id, user_id) DO NOTHING
	`, groupID, userID); err != nil {
		return GroupMember{}, fmt.Errorf("add group member: %w", err)
	}

	member, err := loadGroupMember(ctx, tx, groupID, userID)
	if err != nil {
		return GroupMember{}, err
	}

	return member, nil
}

func (s *Service) AuthorizeAddMemberTx(ctx context.Context, tx pgx.Tx, requesterUserID, groupID string) error {
	organizationID, err := loadGroupOrganizationID(ctx, tx, groupID)
	if err != nil {
		return err
	}
	return requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID)
}

func (s *Service) ListMembers(ctx context.Context, requesterUserID, groupID string) ([]GroupMember, error) {
	organizationID, err := loadGroupOrganizationID(ctx, s.pool, groupID)
	if err != nil {
		return nil, err
	}
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT gm.group_id, u.id, u.email, COALESCE(u.name, '')
		FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_id = $1
		ORDER BY u.email, u.id
	`, groupID)
	if err != nil {
		return nil, fmt.Errorf("query group members: %w", err)
	}
	defer rows.Close()

	members := make([]GroupMember, 0)
	for rows.Next() {
		var member GroupMember
		if err := rows.Scan(&member.GroupID, &member.UserID, &member.Email, &member.Name); err != nil {
			return nil, fmt.Errorf("scan group member: %w", err)
		}
		members = append(members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate group members: %w", err)
	}

	return members, nil
}

func (s *Service) RemoveMember(ctx context.Context, requesterUserID, groupID, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin remove group member tx: %w", err)
	}
	defer tx.Rollback(ctx)

	organizationID, err := loadGroupOrganizationID(ctx, tx, groupID)
	if err != nil {
		return err
	}
	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return err
	}

	result, err := tx.Exec(ctx, `
		DELETE FROM group_members
		WHERE group_id = $1 AND user_id = $2
	`, groupID, userID)
	if err != nil {
		return fmt.Errorf("remove group member: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit remove group member tx: %w", err)
	}

	return nil
}

func requireOrganizationAdmin(ctx context.Context, querier dbQuerier, userID, organizationID string) error {
	var role string
	err := querier.QueryRow(ctx, `
		SELECT role
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, organizationID, userID).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		return fmt.Errorf("query organization role: %w", err)
	}

	switch access.OrganizationRole(strings.TrimSpace(strings.ToLower(role))) {
	case access.OrganizationRoleOwner, access.OrganizationRoleAdmin:
		return nil
	default:
		return ErrForbidden
	}
}

func requireOrganizationMembership(ctx context.Context, querier dbQuerier, organizationID, userID string) error {
	var exists bool
	err := querier.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM organization_members
			WHERE organization_id = $1 AND user_id = $2
		)
	`, organizationID, userID).Scan(&exists)
	if err != nil {
		return fmt.Errorf("query organization membership: %w", err)
	}
	if !exists {
		return ErrForbidden
	}

	return nil
}

func loadGroupOrganizationID(ctx context.Context, querier dbQuerier, groupID string) (string, error) {
	var organizationID string
	err := querier.QueryRow(ctx, `
		SELECT organization_id
		FROM groups
		WHERE id = $1
	`, groupID).Scan(&organizationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("query group organization: %w", err)
	}

	return organizationID, nil
}

func loadGroupMember(ctx context.Context, querier dbQuerier, groupID, userID string) (GroupMember, error) {
	var member GroupMember
	err := querier.QueryRow(ctx, `
		SELECT gm.group_id, u.id, u.email, COALESCE(u.name, '')
		FROM group_members gm
		JOIN users u ON u.id = gm.user_id
		WHERE gm.group_id = $1 AND gm.user_id = $2
	`, groupID, userID).Scan(&member.GroupID, &member.UserID, &member.Email, &member.Name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupMember{}, ErrNotFound
		}
		return GroupMember{}, fmt.Errorf("query group member: %w", err)
	}

	return member, nil
}

package workspaces

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
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
	pool     *pgxpool.Pool
	access   *access.Service
	activity *activity.Service
}

type WorkspaceAccess struct {
	WorkspaceID      string   `json:"workspaceId"`
	WorkspaceName    string   `json:"workspaceName"`
	WorkspaceType    string   `json:"workspaceType"`
	OrganizationID   string   `json:"organizationId"`
	OrganizationName string   `json:"organizationName"`
	Role             string   `json:"role"`
	Sources          []string `json:"sources,omitempty"`
}

type CreateWorkspaceInput struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type UpdateUserAccessInput struct {
	Role string `json:"role"`
}

type UpdateGroupAccessInput struct {
	Role string `json:"role"`
}

type UserAccessGrant struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	Role        string `json:"role"`
}

type GroupAccessGrant struct {
	WorkspaceID string `json:"workspaceId"`
	GroupID     string `json:"groupId"`
	Role        string `json:"role"`
}

type WorkspaceAccessSnapshot struct {
	Workspace       WorkspaceSummary           `json:"workspace"`
	UserGrants      []WorkspaceUserGrantView   `json:"userGrants"`
	GroupGrants     []WorkspaceGroupGrantView  `json:"groupGrants"`
	EffectiveAccess []WorkspaceEffectiveAccess `json:"effectiveAccess"`
}

type WorkspaceSummary struct {
	WorkspaceID      string `json:"workspaceId"`
	WorkspaceName    string `json:"workspaceName"`
	WorkspaceType    string `json:"workspaceType"`
	OrganizationID   string `json:"organizationId"`
	OrganizationName string `json:"organizationName"`
}

type WorkspaceUserGrantView struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Role   string `json:"role"`
}

type WorkspaceGroupGrantView struct {
	GroupID   string `json:"groupId"`
	GroupName string `json:"groupName"`
	Role      string `json:"role"`
}

type WorkspaceEffectiveAccess struct {
	UserID  string   `json:"userId"`
	Email   string   `json:"email"`
	Role    string   `json:"role"`
	Sources []string `json:"sources"`
}

type FolderNode struct {
	ID        string         `json:"id"`
	ParentID  *string        `json:"parentId,omitempty"`
	Name      string         `json:"name"`
	Position  int            `json:"position"`
	Folders   []FolderNode   `json:"folders"`
	Bookmarks []BookmarkNode `json:"bookmarks"`
}

type BookmarkNode struct {
	ID       string `json:"id"`
	FolderID string `json:"folderId"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Position int    `json:"position"`
}

type TreeResponse struct {
	Workspace WorkspaceAccess `json:"workspace"`
	Folders   []FolderNode    `json:"folders"`
}

type folderRow struct {
	ID       string
	ParentID *string
	Name     string
	Position int
}

type bookmarkRow struct {
	ID       string
	FolderID string
	Title    string
	URL      string
	Position int
}

type workspaceMetadataRecord struct {
	WorkspaceID      string
	WorkspaceName    string
	WorkspaceType    string
	OrganizationID   string
	OrganizationName string
}

type workspaceAccessContribution struct {
	UserID string
	Email  string
	Role   access.WorkspaceRole
	Source string
}

func NewService(pool *pgxpool.Pool, accessService *access.Service, activityService *activity.Service) *Service {
	if accessService == nil {
		accessService = access.NewService(pool)
	}

	return &Service{pool: pool, access: accessService, activity: activityService}
}

func (s *Service) ListByOrganization(ctx context.Context, userID, organizationID string) ([]WorkspaceAccess, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.id, w.name, w.type, o.id, o.name,
			CASE MAX(grants.rank)
				WHEN 3 THEN 'admin'
				WHEN 2 THEN 'editor'
				WHEN 1 THEN 'viewer'
			END AS role,
			ARRAY_AGG(DISTINCT grants.source ORDER BY grants.source) AS sources
		FROM workspaces w
		JOIN organizations o ON o.id = w.organization_id
		JOIN (
			SELECT wua.workspace_id,
				CASE wua.role
					WHEN 'admin' THEN 3
					WHEN 'editor' THEN 2
					WHEN 'viewer' THEN 1
					ELSE 0
				END AS rank,
				wua.role,
				'direct' AS source
			FROM workspace_user_access wua
			WHERE wua.user_id = $1

			UNION ALL

			SELECT wga.workspace_id,
				CASE wga.role
					WHEN 'admin' THEN 3
					WHEN 'editor' THEN 2
					WHEN 'viewer' THEN 1
					ELSE 0
				END AS rank,
				wga.role,
				'group:' || wga.group_id::text AS source
			FROM workspace_group_access wga
			JOIN group_members gm ON gm.group_id = wga.group_id
			WHERE gm.user_id = $1

			UNION ALL

			SELECT w.id AS workspace_id, 3 AS rank, 'admin' AS role, 'organization-admin' AS source
			FROM workspaces w
			JOIN organization_members om ON om.organization_id = w.organization_id
			WHERE om.user_id = $1 AND om.role IN ('owner', 'admin')
		) grants ON grants.workspace_id = w.id
		WHERE w.organization_id = $2
		GROUP BY w.id, w.name, w.type, o.id, o.name
		ORDER BY w.name, w.id
	`, userID, organizationID)
	if err != nil {
		return nil, fmt.Errorf("query workspaces by organization: %w", err)
	}
	defer rows.Close()

	workspaces := make([]WorkspaceAccess, 0)
	for rows.Next() {
		var workspace WorkspaceAccess
		if err := rows.Scan(
			&workspace.WorkspaceID,
			&workspace.WorkspaceName,
			&workspace.WorkspaceType,
			&workspace.OrganizationID,
			&workspace.OrganizationName,
			&workspace.Role,
			&workspace.Sources,
		); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		workspaces = append(workspaces, workspace)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspaces: %w", err)
	}

	return workspaces, nil
}

func (s *Service) Create(ctx context.Context, requesterUserID, organizationID string, input CreateWorkspaceInput) (WorkspaceAccess, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceAccess{}, fmt.Errorf("begin create workspace tx: %w", err)
	}
	defer tx.Rollback(ctx)
	workspace, err := s.CreateTx(ctx, tx, requesterUserID, organizationID, input)
	if err != nil {
		return WorkspaceAccess{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceAccess{}, fmt.Errorf("commit create workspace tx: %w", err)
	}
	return workspace, nil
}

func (s *Service) CreateTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string, input CreateWorkspaceInput) (WorkspaceAccess, error) {
	name := strings.TrimSpace(input.Name)
	workspaceType := strings.TrimSpace(input.Type)
	if name == "" {
		return WorkspaceAccess{}, fmt.Errorf("workspace name is required")
	}
	if workspaceType == "" {
		return WorkspaceAccess{}, fmt.Errorf("workspace type is required")
	}

	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return WorkspaceAccess{}, mapAccessError(err)
	}

	var workspaceID string
	err := tx.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, $3)
		RETURNING id
	`, organizationID, name, workspaceType).Scan(&workspaceID)
	if err != nil {
		return WorkspaceAccess{}, fmt.Errorf("create workspace: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_user_access (workspace_id, user_id, role)
		VALUES ($1, $2, $3)
	`, workspaceID, requesterUserID, access.WorkspaceRoleAdmin); err != nil {
		return WorkspaceAccess{}, fmt.Errorf("grant creator workspace access: %w", err)
	}

	workspace, err := s.getAccessibleWorkspace(ctx, tx, requesterUserID, workspaceID)
	if err != nil {
		return WorkspaceAccess{}, err
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindWorkspaceCreated, "workspace", workspaceID, map[string]any{
		"workspaceName": name,
		"workspaceType": workspaceType,
	}); err != nil {
		return WorkspaceAccess{}, fmt.Errorf("record workspace created activity: %w", err)
	}

	return workspace, nil
}

func (s *Service) AuthorizeCreateTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string) error {
	return mapAccessError(access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID))
}

func (s *Service) GrantUserAccess(ctx context.Context, requesterUserID, workspaceID, userID string, input UpdateUserAccessInput) (UserAccessGrant, error) {
	role, err := normalizeWorkspaceRole(input.Role)
	if err != nil {
		return UserAccessGrant{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UserAccessGrant{}, fmt.Errorf("begin grant user access tx: %w", err)
	}
	defer tx.Rollback(ctx)

	organizationID, err := loadWorkspaceOrganizationID(ctx, tx, workspaceID)
	if err != nil {
		return UserAccessGrant{}, err
	}
	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return UserAccessGrant{}, mapAccessError(err)
	}
	if err := requireOrganizationMembership(ctx, tx, organizationID, userID); err != nil {
		return UserAccessGrant{}, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_user_access (workspace_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, user_id) DO UPDATE
		SET role = EXCLUDED.role
	`, workspaceID, userID, role); err != nil {
		return UserAccessGrant{}, fmt.Errorf("upsert user workspace access: %w", err)
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindWorkspaceAccessUserGranted, "workspace_user_access", userID, map[string]any{
		"workspaceId": workspaceID,
		"role":        string(role),
	}); err != nil {
		return UserAccessGrant{}, fmt.Errorf("record workspace user access granted activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return UserAccessGrant{}, fmt.Errorf("commit grant user access tx: %w", err)
	}

	return UserAccessGrant{WorkspaceID: workspaceID, UserID: userID, Role: string(role)}, nil
}

func (s *Service) RevokeUserAccess(ctx context.Context, requesterUserID, workspaceID, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin revoke user access tx: %w", err)
	}
	defer tx.Rollback(ctx)

	organizationID, err := loadWorkspaceOrganizationID(ctx, tx, workspaceID)
	if err != nil {
		return err
	}
	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return mapAccessError(err)
	}

	result, err := tx.Exec(ctx, `
		DELETE FROM workspace_user_access
		WHERE workspace_id = $1 AND user_id = $2
	`, workspaceID, userID)
	if err != nil {
		return fmt.Errorf("delete user workspace access: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindWorkspaceAccessUserRevoked, "workspace_user_access", userID, map[string]any{
		"workspaceId": workspaceID,
	}); err != nil {
		return fmt.Errorf("record workspace user access revoked activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit revoke user access tx: %w", err)
	}

	return nil
}

func (s *Service) GrantGroupAccess(ctx context.Context, requesterUserID, workspaceID, groupID string, input UpdateGroupAccessInput) (GroupAccessGrant, error) {
	role, err := normalizeWorkspaceRole(input.Role)
	if err != nil {
		return GroupAccessGrant{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return GroupAccessGrant{}, fmt.Errorf("begin grant group access tx: %w", err)
	}
	defer tx.Rollback(ctx)

	organizationID, err := loadWorkspaceOrganizationID(ctx, tx, workspaceID)
	if err != nil {
		return GroupAccessGrant{}, err
	}
	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return GroupAccessGrant{}, mapAccessError(err)
	}
	groupOrganizationID, err := loadGroupOrganizationID(ctx, tx, groupID)
	if err != nil {
		return GroupAccessGrant{}, err
	}
	if groupOrganizationID != organizationID {
		return GroupAccessGrant{}, fmt.Errorf("group does not belong to workspace organization")
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_group_access (workspace_id, group_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, group_id) DO UPDATE
		SET role = EXCLUDED.role
	`, workspaceID, groupID, role); err != nil {
		return GroupAccessGrant{}, fmt.Errorf("upsert group workspace access: %w", err)
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindWorkspaceAccessGroupGranted, "workspace_group_access", groupID, map[string]any{
		"workspaceId": workspaceID,
		"role":        string(role),
	}); err != nil {
		return GroupAccessGrant{}, fmt.Errorf("record workspace group access granted activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return GroupAccessGrant{}, fmt.Errorf("commit grant group access tx: %w", err)
	}

	return GroupAccessGrant{WorkspaceID: workspaceID, GroupID: groupID, Role: string(role)}, nil
}

func (s *Service) RevokeGroupAccess(ctx context.Context, requesterUserID, workspaceID, groupID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin revoke group access tx: %w", err)
	}
	defer tx.Rollback(ctx)

	organizationID, err := loadWorkspaceOrganizationID(ctx, tx, workspaceID)
	if err != nil {
		return err
	}
	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return mapAccessError(err)
	}

	result, err := tx.Exec(ctx, `
		DELETE FROM workspace_group_access
		WHERE workspace_id = $1 AND group_id = $2
	`, workspaceID, groupID)
	if err != nil {
		return fmt.Errorf("delete group workspace access: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindWorkspaceAccessGroupRevoked, "workspace_group_access", groupID, map[string]any{
		"workspaceId": workspaceID,
	}); err != nil {
		return fmt.Errorf("record workspace group access revoked activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit revoke group access tx: %w", err)
	}

	return nil
}

func (s *Service) GetAccessSnapshot(ctx context.Context, requesterUserID, workspaceID string) (WorkspaceAccessSnapshot, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return WorkspaceAccessSnapshot{}, fmt.Errorf("begin access snapshot tx: %w", err)
	}
	defer tx.Rollback(ctx)
	metadata, err := loadWorkspaceMetadataRecord(ctx, tx, workspaceID)
	if err != nil {
		return WorkspaceAccessSnapshot{}, err
	}
	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, metadata.OrganizationID); err != nil {
		return WorkspaceAccessSnapshot{}, mapAccessError(err)
	}

	userGrants, err := loadWorkspaceUserGrants(ctx, tx, workspaceID)
	if err != nil {
		return WorkspaceAccessSnapshot{}, err
	}
	groupGrants, err := loadWorkspaceGroupGrants(ctx, tx, workspaceID)
	if err != nil {
		return WorkspaceAccessSnapshot{}, err
	}
	contributions, err := loadWorkspaceAccessContributions(ctx, tx, workspaceID)
	if err != nil {
		return WorkspaceAccessSnapshot{}, err
	}

	snapshot := WorkspaceAccessSnapshot{
		Workspace: WorkspaceSummary{
			WorkspaceID:      metadata.WorkspaceID,
			WorkspaceName:    metadata.WorkspaceName,
			WorkspaceType:    metadata.WorkspaceType,
			OrganizationID:   metadata.OrganizationID,
			OrganizationName: metadata.OrganizationName,
		},
		UserGrants:      userGrants,
		GroupGrants:     groupGrants,
		EffectiveAccess: resolveWorkspaceEffectiveAccess(contributions),
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkspaceAccessSnapshot{}, fmt.Errorf("commit access snapshot tx: %w", err)
	}
	return snapshot, nil
}

func (s *Service) GetAccessibleWorkspace(ctx context.Context, userID, workspaceID string) (WorkspaceAccess, error) {
	return s.getAccessibleWorkspace(ctx, s.pool, userID, workspaceID)
}

func (s *Service) getAccessibleWorkspace(ctx context.Context, querier access.WorkspaceAccessQuerier, userID, workspaceID string) (WorkspaceAccess, error) {
	effectiveAccess, err := access.GetEffectiveWorkspaceAccess(ctx, querier, userID, workspaceID)
	if err != nil {
		return WorkspaceAccess{}, mapAccessError(err)
	}

	return WorkspaceAccess{
		WorkspaceID:      effectiveAccess.WorkspaceID,
		WorkspaceName:    effectiveAccess.WorkspaceName,
		WorkspaceType:    effectiveAccess.WorkspaceType,
		OrganizationID:   effectiveAccess.OrganizationID,
		OrganizationName: effectiveAccess.OrganizationName,
		Role:             string(effectiveAccess.Role),
		Sources:          effectiveAccess.Sources,
	}, nil
}

func (s *Service) GetTree(ctx context.Context, userID, workspaceID string) (TreeResponse, error) {
	workspace, err := s.GetAccessibleWorkspace(ctx, userID, workspaceID)
	if err != nil {
		return TreeResponse{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, parent_id, name, position
		FROM folders
		WHERE workspace_id = $1 AND deleted_at IS NULL
		ORDER BY COALESCE(parent_id::text, ''), position, id
	`, workspaceID)
	if err != nil {
		return TreeResponse{}, fmt.Errorf("query folders: %w", err)
	}
	defer rows.Close()

	folders := make([]folderRow, 0)
	for rows.Next() {
		var (
			id       string
			parentID *string
			name     string
			position int
		)
		if err := rows.Scan(&id, &parentID, &name, &position); err != nil {
			return TreeResponse{}, fmt.Errorf("scan folder: %w", err)
		}
		folders = append(folders, folderRow{ID: id, ParentID: parentID, Name: name, Position: position})
	}
	if err := rows.Err(); err != nil {
		return TreeResponse{}, fmt.Errorf("iterate folders: %w", err)
	}

	bookmarkRows, err := s.pool.Query(ctx, `
		SELECT id, folder_id, title, url, position
		FROM bookmarks
		WHERE workspace_id = $1 AND deleted_at IS NULL
		ORDER BY folder_id, position, id
	`, workspaceID)
	if err != nil {
		return TreeResponse{}, fmt.Errorf("query bookmarks: %w", err)
	}
	defer bookmarkRows.Close()

	bookmarks := make([]bookmarkRow, 0)
	for bookmarkRows.Next() {
		var bookmark bookmarkRow
		if err := bookmarkRows.Scan(&bookmark.ID, &bookmark.FolderID, &bookmark.Title, &bookmark.URL, &bookmark.Position); err != nil {
			return TreeResponse{}, fmt.Errorf("scan bookmark: %w", err)
		}
		bookmarks = append(bookmarks, bookmark)
	}
	if err := bookmarkRows.Err(); err != nil {
		return TreeResponse{}, fmt.Errorf("iterate bookmarks: %w", err)
	}

	return TreeResponse{Workspace: workspace, Folders: buildFolderTree(folders, bookmarks)}, nil
}

func loadWorkspaceOrganizationID(ctx context.Context, querier dbQuerier, workspaceID string) (string, error) {
	var organizationID string
	err := querier.QueryRow(ctx, `
		SELECT organization_id
		FROM workspaces
		WHERE id = $1
	`, workspaceID).Scan(&organizationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("query workspace organization: %w", err)
	}

	return organizationID, nil
}

func loadWorkspaceMetadataRecord(ctx context.Context, querier dbQuerier, workspaceID string) (workspaceMetadataRecord, error) {
	var metadata workspaceMetadataRecord
	err := querier.QueryRow(ctx, `
		SELECT w.id, w.name, w.type, o.id, o.name
		FROM workspaces w
		JOIN organizations o ON o.id = w.organization_id
		WHERE w.id = $1
	`, workspaceID).Scan(
		&metadata.WorkspaceID,
		&metadata.WorkspaceName,
		&metadata.WorkspaceType,
		&metadata.OrganizationID,
		&metadata.OrganizationName,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return workspaceMetadataRecord{}, ErrNotFound
		}
		return workspaceMetadataRecord{}, fmt.Errorf("query workspace metadata: %w", err)
	}

	return metadata, nil
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

func loadWorkspaceUserGrants(ctx context.Context, querier dbQuerier, workspaceID string) ([]WorkspaceUserGrantView, error) {
	rows, err := querier.Query(ctx, `
		SELECT wua.user_id, u.email, wua.role
		FROM workspace_user_access wua
		JOIN users u ON u.id = wua.user_id
		WHERE wua.workspace_id = $1
		ORDER BY u.email, u.id
	`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("query workspace user grants: %w", err)
	}
	defer rows.Close()

	grants := make([]WorkspaceUserGrantView, 0)
	for rows.Next() {
		var grant WorkspaceUserGrantView
		if err := rows.Scan(&grant.UserID, &grant.Email, &grant.Role); err != nil {
			return nil, fmt.Errorf("scan workspace user grant: %w", err)
		}
		grants = append(grants, grant)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace user grants: %w", err)
	}

	return grants, nil
}

func loadWorkspaceGroupGrants(ctx context.Context, querier dbQuerier, workspaceID string) ([]WorkspaceGroupGrantView, error) {
	rows, err := querier.Query(ctx, `
		SELECT wga.group_id, g.name, wga.role
		FROM workspace_group_access wga
		JOIN groups g ON g.id = wga.group_id
		WHERE wga.workspace_id = $1
		ORDER BY g.name, g.id
	`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("query workspace group grants: %w", err)
	}
	defer rows.Close()

	grants := make([]WorkspaceGroupGrantView, 0)
	for rows.Next() {
		var grant WorkspaceGroupGrantView
		if err := rows.Scan(&grant.GroupID, &grant.GroupName, &grant.Role); err != nil {
			return nil, fmt.Errorf("scan workspace group grant: %w", err)
		}
		grants = append(grants, grant)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace group grants: %w", err)
	}

	return grants, nil
}

func loadWorkspaceAccessContributions(ctx context.Context, querier dbQuerier, workspaceID string) ([]workspaceAccessContribution, error) {
	rows, err := querier.Query(ctx, `
		SELECT contribution.user_id, contribution.email, contribution.role, contribution.source
		FROM (
			SELECT wua.user_id, u.email, wua.role, 'direct' AS source
			FROM workspace_user_access wua
			JOIN users u ON u.id = wua.user_id
			WHERE wua.workspace_id = $1

			UNION ALL

			SELECT u.id, u.email, wga.role, 'group:' || wga.group_id::text AS source
			FROM workspace_group_access wga
			JOIN group_members gm ON gm.group_id = wga.group_id
			JOIN users u ON u.id = gm.user_id
			WHERE wga.workspace_id = $1
		) contribution
		ORDER BY contribution.email, contribution.user_id, contribution.source
	`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("query workspace access contributions: %w", err)
	}
	defer rows.Close()

	contributions := make([]workspaceAccessContribution, 0)
	for rows.Next() {
		var contribution workspaceAccessContribution
		if err := rows.Scan(&contribution.UserID, &contribution.Email, &contribution.Role, &contribution.Source); err != nil {
			return nil, fmt.Errorf("scan workspace access contribution: %w", err)
		}
		contributions = append(contributions, contribution)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace access contributions: %w", err)
	}

	return contributions, nil
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

func normalizeWorkspaceRole(rawRole string) (access.WorkspaceRole, error) {
	switch access.WorkspaceRole(strings.TrimSpace(strings.ToLower(rawRole))) {
	case access.WorkspaceRoleAdmin:
		return access.WorkspaceRoleAdmin, nil
	case access.WorkspaceRoleEditor:
		return access.WorkspaceRoleEditor, nil
	case access.WorkspaceRoleViewer:
		return access.WorkspaceRoleViewer, nil
	default:
		return "", fmt.Errorf("workspace role must be one of admin, editor, viewer")
	}
}

func mapAccessError(err error) error {
	if errors.Is(err, access.ErrForbidden) {
		return ErrForbidden
	}

	return err
}

func resolveWorkspaceEffectiveAccess(contributions []workspaceAccessContribution) []WorkspaceEffectiveAccess {
	if len(contributions) == 0 {
		return []WorkspaceEffectiveAccess{}
	}

	type aggregate struct {
		userID  string
		email   string
		role    access.WorkspaceRole
		sources []string
	}

	aggregates := make(map[string]*aggregate, len(contributions))
	for _, contribution := range contributions {
		current := aggregates[contribution.UserID]
		if current == nil {
			current = &aggregate{userID: contribution.UserID, email: contribution.Email}
			aggregates[contribution.UserID] = current
		}

		if rankWorkspaceRole(contribution.Role) > rankWorkspaceRole(current.role) {
			current.role = contribution.Role
		}
		current.sources = append(current.sources, contribution.Source)
	}

	resolved := make([]WorkspaceEffectiveAccess, 0, len(aggregates))
	for _, current := range aggregates {
		resolved = append(resolved, WorkspaceEffectiveAccess{
			UserID:  current.userID,
			Email:   current.email,
			Role:    string(current.role),
			Sources: dedupeAndSortWorkspaceSources(current.sources),
		})
	}

	sort.Slice(resolved, func(i, j int) bool {
		if resolved[i].Email == resolved[j].Email {
			return resolved[i].UserID < resolved[j].UserID
		}
		return resolved[i].Email < resolved[j].Email
	})

	return resolved
}

func dedupeAndSortWorkspaceSources(sources []string) []string {
	if len(sources) == 0 {
		return []string{}
	}

	seen := make(map[string]struct{}, len(sources))
	groupSources := make([]string, 0, len(sources))
	hasDirect := false
	for _, source := range sources {
		if _, exists := seen[source]; exists {
			continue
		}
		seen[source] = struct{}{}
		if source == "direct" {
			hasDirect = true
			continue
		}
		groupSources = append(groupSources, source)
	}

	sort.Strings(groupSources)
	resolved := make([]string, 0, len(groupSources)+1)
	if hasDirect {
		resolved = append(resolved, "direct")
	}
	resolved = append(resolved, groupSources...)
	return resolved
}

func rankWorkspaceRole(role access.WorkspaceRole) int {
	switch role {
	case access.WorkspaceRoleAdmin:
		return 3
	case access.WorkspaceRoleEditor:
		return 2
	case access.WorkspaceRoleViewer:
		return 1
	default:
		return 0
	}
}

func buildFolderTree(folders []folderRow, bookmarks []bookmarkRow) []FolderNode {
	foldersByID := make(map[string]*FolderNode, len(folders))
	childrenByParent := make(map[string][]string)
	rootIDs := make([]string, 0)

	for _, folder := range folders {
		folderNode := &FolderNode{
			ID:        folder.ID,
			ParentID:  folder.ParentID,
			Name:      folder.Name,
			Position:  folder.Position,
			Folders:   []FolderNode{},
			Bookmarks: []BookmarkNode{},
		}
		foldersByID[folder.ID] = folderNode
		if folder.ParentID == nil {
			rootIDs = append(rootIDs, folder.ID)
			continue
		}
		childrenByParent[*folder.ParentID] = append(childrenByParent[*folder.ParentID], folder.ID)
	}

	for _, bookmark := range bookmarks {
		if folder := foldersByID[bookmark.FolderID]; folder != nil {
			folder.Bookmarks = append(folder.Bookmarks, BookmarkNode{
				ID:       bookmark.ID,
				FolderID: bookmark.FolderID,
				Title:    bookmark.Title,
				URL:      bookmark.URL,
				Position: bookmark.Position,
			})
		}
	}

	var build func(string) FolderNode
	build = func(id string) FolderNode {
		folder := foldersByID[id]
		result := *folder
		result.Folders = make([]FolderNode, 0, len(childrenByParent[id]))
		for _, childID := range childrenByParent[id] {
			result.Folders = append(result.Folders, build(childID))
		}
		return result
	}

	tree := make([]FolderNode, 0, len(rootIDs))
	for _, rootID := range rootIDs {
		tree = append(tree, build(rootID))
	}

	return tree
}

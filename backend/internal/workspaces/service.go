package workspaces

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
	pool   *pgxpool.Pool
	access *access.Service
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

func NewService(pool *pgxpool.Pool, accessService *access.Service) *Service {
	if accessService == nil {
		accessService = access.NewService(pool)
	}

	return &Service{pool: pool, access: accessService}
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
	name := strings.TrimSpace(input.Name)
	workspaceType := strings.TrimSpace(input.Type)
	if name == "" {
		return WorkspaceAccess{}, fmt.Errorf("workspace name is required")
	}
	if workspaceType == "" {
		return WorkspaceAccess{}, fmt.Errorf("workspace type is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return WorkspaceAccess{}, fmt.Errorf("begin create workspace tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := access.RequireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return WorkspaceAccess{}, mapAccessError(err)
	}

	var workspaceID string
	err = tx.QueryRow(ctx, `
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

	if err := tx.Commit(ctx); err != nil {
		return WorkspaceAccess{}, fmt.Errorf("commit create workspace tx: %w", err)
	}

	return workspace, nil
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

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit revoke group access tx: %w", err)
	}

	return nil
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

package workspaces

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrForbidden = errors.New("forbidden")

type Service struct {
	pool *pgxpool.Pool
}

type WorkspaceAccess struct {
	WorkspaceID      string `json:"workspaceId"`
	WorkspaceName    string `json:"workspaceName"`
	WorkspaceType    string `json:"workspaceType"`
	OrganizationID   string `json:"organizationId"`
	OrganizationName string `json:"organizationName"`
	Role             string `json:"role"`
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

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) ListByOrganization(ctx context.Context, userID, organizationID string) ([]WorkspaceAccess, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.id, w.name, w.type, o.id, o.name, wm.role
		FROM workspace_members wm
		JOIN workspaces w ON w.id = wm.workspace_id
		JOIN organizations o ON o.id = w.organization_id
		WHERE wm.user_id = $1 AND w.organization_id = $2
		ORDER BY w.name, w.id
	`, userID, organizationID)
	if err != nil {
		return nil, fmt.Errorf("query workspaces by organization: %w", err)
	}
	defer rows.Close()

	workspaces := make([]WorkspaceAccess, 0)
	for rows.Next() {
		var workspace WorkspaceAccess
		if err := rows.Scan(&workspace.WorkspaceID, &workspace.WorkspaceName, &workspace.WorkspaceType, &workspace.OrganizationID, &workspace.OrganizationName, &workspace.Role); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		workspaces = append(workspaces, workspace)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspaces: %w", err)
	}

	return workspaces, nil
}

func (s *Service) GetAccessibleWorkspace(ctx context.Context, userID, workspaceID string) (WorkspaceAccess, error) {
	var access WorkspaceAccess
	err := s.pool.QueryRow(ctx, `
		SELECT w.id, w.name, w.type, o.id, o.name, wm.role
		FROM workspace_members wm
		JOIN workspaces w ON w.id = wm.workspace_id
		JOIN organizations o ON o.id = w.organization_id
		WHERE wm.user_id = $1 AND wm.workspace_id = $2
	`, userID, workspaceID).Scan(
		&access.WorkspaceID,
		&access.WorkspaceName,
		&access.WorkspaceType,
		&access.OrganizationID,
		&access.OrganizationName,
		&access.Role,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceAccess{}, ErrForbidden
		}
		return WorkspaceAccess{}, fmt.Errorf("query workspace access: %w", err)
	}

	return access, nil
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

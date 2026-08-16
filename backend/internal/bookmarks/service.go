package bookmarks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden = errors.New("forbidden")
	ErrNotFound  = errors.New("not found")
)

type Service struct {
	pool   *pgxpool.Pool
	access *access.Service
}

type Folder struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspaceId"`
	ParentID    *string `json:"parentId,omitempty"`
	Name        string  `json:"name"`
	Position    int     `json:"position"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

type Bookmark struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	FolderID    string `json:"folderId"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	Position    int    `json:"position"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type CreateFolderInput struct {
	ParentID *string `json:"parentId"`
	Name     string  `json:"name"`
	Position *int    `json:"position"`
}

type UpdateFolderInput struct {
	Name     *string        `json:"name"`
	ParentID OptionalString `json:"parentId"`
	Position OptionalInt    `json:"position"`
}

type CreateBookmarkInput struct {
	FolderID string `json:"folderId"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Position *int   `json:"position"`
}

type UpdateBookmarkInput struct {
	FolderID OptionalString `json:"folderId"`
	Title    *string        `json:"title"`
	URL      *string        `json:"url"`
	Position OptionalInt    `json:"position"`
}

type OptionalString struct {
	Set   bool
	Value *string
}

func (o *OptionalString) UnmarshalJSON(data []byte) error {
	o.Set = true
	if bytes.Equal(data, []byte("null")) {
		o.Value = nil
		return nil
	}

	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}

	trimmed := strings.TrimSpace(value)
	o.Value = &trimmed
	return nil
}

type OptionalInt struct {
	Set   bool
	Value int
}

func (o *OptionalInt) UnmarshalJSON(data []byte) error {
	o.Set = true
	return json.Unmarshal(data, &o.Value)
}

func NewService(pool *pgxpool.Pool, accessService *access.Service) *Service {
	if accessService == nil {
		accessService = access.NewService(pool)
	}

	return &Service{pool: pool, access: accessService}
}

func (s *Service) CreateFolder(ctx context.Context, userID, workspaceID string, input CreateFolderInput) (Folder, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Folder{}, fmt.Errorf("begin create folder tx: %w", err)
	}
	defer tx.Rollback(ctx)

	folder, err := s.CreateFolderTx(ctx, tx, userID, workspaceID, input)
	if err != nil {
		return Folder{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Folder{}, fmt.Errorf("commit create folder tx: %w", err)
	}

	return folder, nil
}

func (s *Service) CreateFolderTx(ctx context.Context, tx pgx.Tx, userID, workspaceID string, input CreateFolderInput) (Folder, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		return Folder{}, fmt.Errorf("folder name is required")
	}

	if err := s.requireMutatingRole(ctx, tx, userID, workspaceID); err != nil {
		return Folder{}, err
	}
	if err := s.ensureFolderParent(ctx, tx, workspaceID, input.ParentID); err != nil {
		return Folder{}, err
	}

	var (
		folder               Folder
		createdAt, updatedAt time.Time
		err                  error
	)
	err = tx.QueryRow(ctx, `
		INSERT INTO folders (workspace_id, parent_id, name, position)
		VALUES ($1, $2, $3, 0)
		RETURNING id, workspace_id, parent_id, name, position, created_at, updated_at
	`, workspaceID, input.ParentID, input.Name).Scan(&folder.ID, &folder.WorkspaceID, &folder.ParentID, &folder.Name, &folder.Position, &createdAt, &updatedAt)
	if err != nil {
		return Folder{}, fmt.Errorf("insert folder: %w", err)
	}

	if err := s.reorderFolderSiblings(ctx, tx, workspaceID, input.ParentID, folder.ID, input.Position); err != nil {
		return Folder{}, err
	}

	folder.Position, err = s.currentFolderPosition(ctx, tx, folder.ID)
	if err != nil {
		return Folder{}, err
	}
	folder.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	folder.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	return folder, nil
}

func (s *Service) UpdateFolder(ctx context.Context, userID, folderID string, input UpdateFolderInput) (Folder, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Folder{}, fmt.Errorf("begin update folder tx: %w", err)
	}
	defer tx.Rollback(ctx)

	folder, err := s.UpdateFolderTx(ctx, tx, userID, folderID, input)
	if err != nil {
		return Folder{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Folder{}, fmt.Errorf("commit update folder tx: %w", err)
	}

	return folder, nil
}

func (s *Service) UpdateFolderTx(ctx context.Context, tx pgx.Tx, userID, folderID string, input UpdateFolderInput) (Folder, error) {

	var (
		folder Folder
		err    error
	)
	err = tx.QueryRow(ctx, `
		SELECT id, workspace_id, parent_id, name, position
		FROM folders
		WHERE id = $1 AND deleted_at IS NULL
	`, folderID).Scan(&folder.ID, &folder.WorkspaceID, &folder.ParentID, &folder.Name, &folder.Position)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Folder{}, ErrNotFound
		}
		return Folder{}, fmt.Errorf("load folder: %w", err)
	}

	if err := s.requireMutatingRole(ctx, tx, userID, folder.WorkspaceID); err != nil {
		return Folder{}, err
	}

	targetParent := folder.ParentID
	if input.ParentID.Set {
		targetParent = input.ParentID.Value
	}
	if err := s.ensureFolderParent(ctx, tx, folder.WorkspaceID, targetParent); err != nil {
		return Folder{}, err
	}
	if err := s.ensureFolderNotDescendant(ctx, tx, folder.ID, targetParent); err != nil {
		return Folder{}, err
	}

	targetName := folder.Name
	if input.Name != nil {
		targetName = strings.TrimSpace(*input.Name)
		if targetName == "" {
			return Folder{}, fmt.Errorf("folder name is required")
		}
	}

	_, err = tx.Exec(ctx, `UPDATE folders SET parent_id = $2, name = $3, updated_at = NOW() WHERE id = $1`, folder.ID, targetParent, targetName)
	if err != nil {
		return Folder{}, fmt.Errorf("update folder: %w", err)
	}

	if !sameOptionalString(folder.ParentID, targetParent) {
		if err := s.reorderFolderSiblings(ctx, tx, folder.WorkspaceID, folder.ParentID, "", nil); err != nil {
			return Folder{}, err
		}
	}

	position := &folder.Position
	if input.Position.Set {
		position = &input.Position.Value
	} else if !sameOptionalString(folder.ParentID, targetParent) {
		position = nil
	}

	if err := s.reorderFolderSiblings(ctx, tx, folder.WorkspaceID, targetParent, folder.ID, position); err != nil {
		return Folder{}, err
	}

	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `SELECT parent_id, name, position, created_at, updated_at FROM folders WHERE id = $1`, folder.ID).Scan(&folder.ParentID, &folder.Name, &folder.Position, &createdAt, &updatedAt)
	if err != nil {
		return Folder{}, fmt.Errorf("reload folder: %w", err)
	}
	folder.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	folder.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	return folder, nil
}

// ApplyPreparedFolderPatchTx applies the exact normalized final state from a
// patch prepared in this caller-owned transaction. It performs no validation or
// locking because preparation already retained the required row and scope locks.
func (s *Service) ApplyPreparedFolderPatchTx(ctx context.Context, tx pgx.Tx, patch PreparedFolderPatch) (Folder, error) {
	if patch.NoOp {
		return cloneFolder(patch.Final), nil
	}

	if _, err := tx.Exec(ctx, `UPDATE folders SET parent_id = $2, name = $3 WHERE id = $1`, patch.Final.ID, patch.Final.ParentID, patch.Final.Name); err != nil {
		return Folder{}, fmt.Errorf("apply prepared folder patch: %w", err)
	}
	if !sameOptionalString(patch.Original.ParentID, patch.Final.ParentID) {
		if err := s.reorderFolderSiblings(ctx, tx, patch.Original.WorkspaceID, patch.Original.ParentID, "", nil); err != nil {
			return Folder{}, err
		}
	}
	if err := s.reorderFolderSiblings(ctx, tx, patch.Final.WorkspaceID, patch.Final.ParentID, patch.Final.ID, &patch.Final.Position); err != nil {
		return Folder{}, err
	}
	return cloneFolder(patch.Final), nil
}

func (s *Service) DeleteFolder(ctx context.Context, userID, folderID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delete folder tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := s.DeleteFolderTx(ctx, tx, userID, folderID); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delete folder tx: %w", err)
	}

	return nil
}

func (s *Service) DeleteFolderTx(ctx context.Context, tx pgx.Tx, userID, folderID string) error {
	var workspaceID string
	var parentID *string
	err := tx.QueryRow(ctx, `SELECT workspace_id, parent_id FROM folders WHERE id = $1 AND deleted_at IS NULL`, folderID).Scan(&workspaceID, &parentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load folder for delete: %w", err)
	}

	if err := s.requireMutatingRole(ctx, tx, userID, workspaceID); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		WITH RECURSIVE subtree AS (
			SELECT id FROM folders WHERE id = $1 AND deleted_at IS NULL
			UNION ALL
			SELECT child.id FROM folders child JOIN subtree s ON child.parent_id = s.id WHERE child.deleted_at IS NULL
		)
		UPDATE folders SET deleted_at = NOW(), updated_at = NOW() WHERE id IN (SELECT id FROM subtree)
	`, folderID); err != nil {
		return fmt.Errorf("soft delete folders: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		WITH RECURSIVE subtree AS (
			SELECT id FROM folders WHERE id = $1
			UNION ALL
			SELECT child.id FROM folders child JOIN subtree s ON child.parent_id = s.id
		)
		UPDATE bookmarks SET deleted_at = NOW(), updated_at = NOW() WHERE folder_id IN (SELECT id FROM subtree) AND deleted_at IS NULL
	`, folderID); err != nil {
		return fmt.Errorf("soft delete folder bookmarks: %w", err)
	}

	if err := s.reorderFolderSiblings(ctx, tx, workspaceID, parentID, "", nil); err != nil {
		return err
	}

	return nil
}

func (s *Service) CreateBookmark(ctx context.Context, userID, workspaceID string, input CreateBookmarkInput) (Bookmark, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Bookmark{}, fmt.Errorf("begin create bookmark tx: %w", err)
	}
	defer tx.Rollback(ctx)

	bookmark, err := s.CreateBookmarkTx(ctx, tx, userID, workspaceID, input)
	if err != nil {
		return Bookmark{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Bookmark{}, fmt.Errorf("commit create bookmark tx: %w", err)
	}

	return bookmark, nil
}

func (s *Service) CreateBookmarkTx(ctx context.Context, tx pgx.Tx, userID, workspaceID string, input CreateBookmarkInput) (Bookmark, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.URL = strings.TrimSpace(input.URL)
	if input.Title == "" {
		return Bookmark{}, fmt.Errorf("bookmark title is required")
	}
	if err := validateURL(input.URL); err != nil {
		return Bookmark{}, err
	}

	if err := s.requireMutatingRole(ctx, tx, userID, workspaceID); err != nil {
		return Bookmark{}, err
	}
	if err := s.ensureBookmarkFolder(ctx, tx, workspaceID, input.FolderID); err != nil {
		return Bookmark{}, err
	}

	var (
		bookmark             Bookmark
		createdAt, updatedAt time.Time
		err                  error
	)
	err = tx.QueryRow(ctx, `
		INSERT INTO bookmarks (workspace_id, folder_id, title, url, position)
		VALUES ($1, $2, $3, $4, 0)
		RETURNING id, workspace_id, folder_id, title, url, position, created_at, updated_at
	`, workspaceID, input.FolderID, input.Title, input.URL).Scan(&bookmark.ID, &bookmark.WorkspaceID, &bookmark.FolderID, &bookmark.Title, &bookmark.URL, &bookmark.Position, &createdAt, &updatedAt)
	if err != nil {
		return Bookmark{}, fmt.Errorf("insert bookmark: %w", err)
	}

	if err := s.reorderBookmarkSiblings(ctx, tx, workspaceID, input.FolderID, bookmark.ID, input.Position); err != nil {
		return Bookmark{}, err
	}

	bookmark.Position, err = s.currentBookmarkPosition(ctx, tx, bookmark.ID)
	if err != nil {
		return Bookmark{}, err
	}
	bookmark.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	bookmark.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	return bookmark, nil
}

func (s *Service) UpdateBookmark(ctx context.Context, userID, bookmarkID string, input UpdateBookmarkInput) (Bookmark, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Bookmark{}, fmt.Errorf("begin update bookmark tx: %w", err)
	}
	defer tx.Rollback(ctx)

	bookmark, err := s.UpdateBookmarkTx(ctx, tx, userID, bookmarkID, input)
	if err != nil {
		return Bookmark{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Bookmark{}, fmt.Errorf("commit update bookmark tx: %w", err)
	}

	return bookmark, nil
}

func (s *Service) UpdateBookmarkTx(ctx context.Context, tx pgx.Tx, userID, bookmarkID string, input UpdateBookmarkInput) (Bookmark, error) {

	var (
		bookmark Bookmark
		err      error
	)
	err = tx.QueryRow(ctx, `
		SELECT id, workspace_id, folder_id, title, url, position
		FROM bookmarks
		WHERE id = $1 AND deleted_at IS NULL
	`, bookmarkID).Scan(&bookmark.ID, &bookmark.WorkspaceID, &bookmark.FolderID, &bookmark.Title, &bookmark.URL, &bookmark.Position)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Bookmark{}, ErrNotFound
		}
		return Bookmark{}, fmt.Errorf("load bookmark: %w", err)
	}

	if err := s.requireMutatingRole(ctx, tx, userID, bookmark.WorkspaceID); err != nil {
		return Bookmark{}, err
	}

	targetFolderID := bookmark.FolderID
	if input.FolderID.Set && input.FolderID.Value != nil {
		targetFolderID = *input.FolderID.Value
	}
	if err := s.ensureBookmarkFolder(ctx, tx, bookmark.WorkspaceID, targetFolderID); err != nil {
		return Bookmark{}, err
	}

	targetTitle := bookmark.Title
	if input.Title != nil {
		targetTitle = strings.TrimSpace(*input.Title)
		if targetTitle == "" {
			return Bookmark{}, fmt.Errorf("bookmark title is required")
		}
	}

	targetURL := bookmark.URL
	if input.URL != nil {
		targetURL = strings.TrimSpace(*input.URL)
		if err := validateURL(targetURL); err != nil {
			return Bookmark{}, err
		}
	}

	_, err = tx.Exec(ctx, `UPDATE bookmarks SET folder_id = $2, title = $3, url = $4, updated_at = NOW() WHERE id = $1`, bookmark.ID, targetFolderID, targetTitle, targetURL)
	if err != nil {
		return Bookmark{}, fmt.Errorf("update bookmark: %w", err)
	}

	if bookmark.FolderID != targetFolderID {
		if err := s.reorderBookmarkSiblings(ctx, tx, bookmark.WorkspaceID, bookmark.FolderID, "", nil); err != nil {
			return Bookmark{}, err
		}
	}

	position := &bookmark.Position
	if input.Position.Set {
		position = &input.Position.Value
	} else if bookmark.FolderID != targetFolderID {
		position = nil
	}

	if err := s.reorderBookmarkSiblings(ctx, tx, bookmark.WorkspaceID, targetFolderID, bookmark.ID, position); err != nil {
		return Bookmark{}, err
	}

	var createdAt, updatedAt time.Time
	err = tx.QueryRow(ctx, `SELECT folder_id, title, url, position, created_at, updated_at FROM bookmarks WHERE id = $1`, bookmark.ID).Scan(&bookmark.FolderID, &bookmark.Title, &bookmark.URL, &bookmark.Position, &createdAt, &updatedAt)
	if err != nil {
		return Bookmark{}, fmt.Errorf("reload bookmark: %w", err)
	}
	bookmark.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	bookmark.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	return bookmark, nil
}

// ApplyPreparedBookmarkPatchTx applies the exact normalized final state from a
// patch prepared in this caller-owned transaction. It performs no validation or
// locking because preparation already retained the required row and scope locks.
func (s *Service) ApplyPreparedBookmarkPatchTx(ctx context.Context, tx pgx.Tx, patch PreparedBookmarkPatch) (Bookmark, error) {
	if patch.NoOp {
		return cloneBookmark(patch.Final), nil
	}

	if _, err := tx.Exec(ctx, `UPDATE bookmarks SET folder_id = $2, title = $3, url = $4 WHERE id = $1`, patch.Final.ID, patch.Final.FolderID, patch.Final.Title, patch.Final.URL); err != nil {
		return Bookmark{}, fmt.Errorf("apply prepared bookmark patch: %w", err)
	}
	if patch.Original.FolderID != patch.Final.FolderID {
		if err := s.reorderBookmarkSiblings(ctx, tx, patch.Original.WorkspaceID, patch.Original.FolderID, "", nil); err != nil {
			return Bookmark{}, err
		}
	}
	if err := s.reorderBookmarkSiblings(ctx, tx, patch.Final.WorkspaceID, patch.Final.FolderID, patch.Final.ID, &patch.Final.Position); err != nil {
		return Bookmark{}, err
	}
	return cloneBookmark(patch.Final), nil
}

func (s *Service) DeleteBookmark(ctx context.Context, userID, bookmarkID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delete bookmark tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := s.DeleteBookmarkTx(ctx, tx, userID, bookmarkID); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delete bookmark tx: %w", err)
	}

	return nil
}

func (s *Service) DeleteBookmarkTx(ctx context.Context, tx pgx.Tx, userID, bookmarkID string) error {

	var workspaceID, folderID string
	err := tx.QueryRow(ctx, `SELECT workspace_id, folder_id FROM bookmarks WHERE id = $1 AND deleted_at IS NULL`, bookmarkID).Scan(&workspaceID, &folderID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("load bookmark for delete: %w", err)
	}

	if err := s.requireMutatingRole(ctx, tx, userID, workspaceID); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `UPDATE bookmarks SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, bookmarkID); err != nil {
		return fmt.Errorf("soft delete bookmark: %w", err)
	}

	if err := s.reorderBookmarkSiblings(ctx, tx, workspaceID, folderID, "", nil); err != nil {
		return err
	}

	return nil
}

func (s *Service) requireMutatingRole(ctx context.Context, tx pgx.Tx, userID, workspaceID string) error {
	if _, err := access.RequireWorkspaceWriteAccess(ctx, tx, userID, workspaceID); err != nil {
		if errors.Is(err, access.ErrForbidden) {
			return ErrForbidden
		}
		return err
	}

	return nil
}

func (s *Service) ensureFolderParent(ctx context.Context, tx pgx.Tx, workspaceID string, parentID *string) error {
	if parentID == nil {
		return nil
	}

	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL)`, *parentID, workspaceID).Scan(&exists)
	if err != nil {
		return fmt.Errorf("validate folder parent: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func (s *Service) ensureFolderNotDescendant(ctx context.Context, tx pgx.Tx, folderID string, parentID *string) error {
	if parentID == nil {
		return nil
	}
	if *parentID == folderID {
		return fmt.Errorf("folder cannot be its own parent")
	}

	var descendant bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE subtree AS (
			SELECT id FROM folders WHERE id = $1
			UNION ALL
			SELECT child.id FROM folders child JOIN subtree s ON child.parent_id = s.id WHERE child.deleted_at IS NULL
		)
		SELECT EXISTS(SELECT 1 FROM subtree WHERE id = $2)
	`, folderID, *parentID).Scan(&descendant)
	if err != nil {
		return fmt.Errorf("validate folder ancestry: %w", err)
	}
	if descendant {
		return fmt.Errorf("folder cannot move into its own subtree")
	}
	return nil
}

func (s *Service) ensureBookmarkFolder(ctx context.Context, tx pgx.Tx, workspaceID, folderID string) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL)`, folderID, workspaceID).Scan(&exists)
	if err != nil {
		return fmt.Errorf("validate bookmark folder: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func (s *Service) reorderFolderSiblings(ctx context.Context, tx pgx.Tx, workspaceID string, parentID *string, movingID string, requestedPosition *int) error {
	var movingUUID *string
	if movingID != "" {
		movingUUID = &movingID
	}

	rows, err := tx.Query(ctx, `
		SELECT id
		FROM folders
		WHERE workspace_id = $1
		  AND deleted_at IS NULL
		  AND (($2::uuid IS NULL AND parent_id IS NULL) OR parent_id = $2)
		  AND ($3::uuid IS NULL OR id <> $3::uuid)
		ORDER BY position, id
	`, workspaceID, parentID, movingUUID)
	if err != nil {
		return fmt.Errorf("query folder siblings: %w", err)
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return fmt.Errorf("scan folder sibling: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate folder siblings: %w", err)
	}

	ids = insertAt(ids, movingID, requestedPosition)
	for idx, id := range ids {
		if _, err := tx.Exec(ctx, `UPDATE folders SET position = $2, updated_at = NOW() WHERE id = $1`, id, idx); err != nil {
			return fmt.Errorf("update folder position: %w", err)
		}
	}

	return nil
}

func (s *Service) reorderBookmarkSiblings(ctx context.Context, tx pgx.Tx, workspaceID, folderID, movingID string, requestedPosition *int) error {
	var movingUUID *string
	if movingID != "" {
		movingUUID = &movingID
	}

	rows, err := tx.Query(ctx, `
		SELECT id
		FROM bookmarks
		WHERE workspace_id = $1
		  AND folder_id = $2
		  AND deleted_at IS NULL
		  AND ($3::uuid IS NULL OR id <> $3::uuid)
		ORDER BY position, id
	`, workspaceID, folderID, movingUUID)
	if err != nil {
		return fmt.Errorf("query bookmark siblings: %w", err)
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return fmt.Errorf("scan bookmark sibling: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate bookmark siblings: %w", err)
	}

	ids = insertAt(ids, movingID, requestedPosition)
	for idx, id := range ids {
		if _, err := tx.Exec(ctx, `UPDATE bookmarks SET position = $2, updated_at = NOW() WHERE id = $1`, id, idx); err != nil {
			return fmt.Errorf("update bookmark position: %w", err)
		}
	}

	return nil
}

func (s *Service) currentFolderPosition(ctx context.Context, tx pgx.Tx, folderID string) (int, error) {
	var position int
	if err := tx.QueryRow(ctx, `SELECT position FROM folders WHERE id = $1`, folderID).Scan(&position); err != nil {
		return 0, fmt.Errorf("reload folder position: %w", err)
	}
	return position, nil
}

func (s *Service) currentBookmarkPosition(ctx context.Context, tx pgx.Tx, bookmarkID string) (int, error) {
	var position int
	if err := tx.QueryRow(ctx, `SELECT position FROM bookmarks WHERE id = $1`, bookmarkID).Scan(&position); err != nil {
		return 0, fmt.Errorf("reload bookmark position: %w", err)
	}
	return position, nil
}

func insertAt(ids []string, movingID string, requestedPosition *int) []string {
	if movingID == "" {
		return ids
	}

	position := len(ids)
	if requestedPosition != nil {
		position = *requestedPosition
		if position < 0 {
			position = 0
		}
		if position > len(ids) {
			position = len(ids)
		}
	}

	ids = append(ids, "")
	copy(ids[position+1:], ids[position:])
	ids[position] = movingID
	return ids
}

func sameOptionalString(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func validateURL(rawURL string) error {
	parsed, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("invalid URL: only http and https are allowed")
	}
	if parsed.Host == "" {
		return fmt.Errorf("invalid URL: host is required")
	}
	return nil
}

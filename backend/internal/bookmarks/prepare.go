package bookmarks

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PreparedFolderPatch is the immutable, normalized result of folder update preparation.
type PreparedFolderPatch struct {
	Original    Folder
	Final       Folder
	Fingerprint string
	NoOp        bool
}

// PreparedBookmarkPatch is the immutable, normalized result of bookmark update preparation.
type PreparedBookmarkPatch struct {
	Original    Bookmark
	Final       Bookmark
	Fingerprint string
	NoOp        bool
}

type siblingScopeKey struct {
	kind        string
	workspaceID string
	parentID    string
}

type prepareScopeDriftError struct{}

func (e *prepareScopeDriftError) Error() string { return "prepare scope drift" }

func isRetryablePrepareError(err error) bool {
	var drift *prepareScopeDriftError
	return errors.As(err, &drift)
}

// prepareScopesTx locks every discovered scope before the caller may lock a
// target or sibling row, then refuses the transaction if locked rederivation
// observes different scopes.
func prepareScopesTx(ctx context.Context, tx pgx.Tx, scopes []siblingScopeKey, lockRows func() error, rederive func() ([]siblingScopeKey, error)) error {
	initial := sortedScopeKeys(scopes)
	if err := lockScopesTx(ctx, tx, initial); err != nil {
		return err
	}
	if err := lockRows(); err != nil {
		return err
	}
	current, err := rederive()
	if err != nil {
		return err
	}
	if !equalScopeKeys(initial, sortedScopeKeys(current)) {
		return &prepareScopeDriftError{}
	}
	return nil
}

func lockScopesTx(ctx context.Context, tx pgx.Tx, scopes []siblingScopeKey) error {
	for _, scope := range sortedScopeKeys(scopes) {
		hash := fnv.New64a()
		_, _ = fmt.Fprintf(hash, "%s:%s:%s", scope.kind, scope.workspaceID, scope.parentID)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(hash.Sum64())); err != nil {
			return fmt.Errorf("lock prepare scope: %w", err)
		}
	}
	return nil
}

func sortedScopeKeys(scopes []siblingScopeKey) []siblingScopeKey {
	keys := append([]siblingScopeKey(nil), scopes...)
	sort.Slice(keys, func(i, j int) bool {
		return keys[i].kind+"\x00"+keys[i].workspaceID+"\x00"+keys[i].parentID < keys[j].kind+"\x00"+keys[j].workspaceID+"\x00"+keys[j].parentID
	})
	result := keys[:0]
	for _, key := range keys {
		if len(result) == 0 || result[len(result)-1] != key {
			result = append(result, key)
		}
	}
	return result
}

func equalScopeKeys(left, right []siblingScopeKey) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// PrepareFolderPatchTx authenticates, locks, and normalizes a folder update in
// the caller-owned transaction. It never changes resource, ordering, event, or cursor state.
func (s *Service) PrepareFolderPatchTx(ctx context.Context, tx pgx.Tx, userID, folderID string, input UpdateFolderInput) (PreparedFolderPatch, error) {
	discovered, err := loadFolderForPrepare(ctx, tx, folderID, false)
	if err != nil {
		return PreparedFolderPatch{}, err
	}
	targetParent := discovered.ParentID
	if input.ParentID.Set {
		targetParent = input.ParentID.Value
	}

	var locked Folder
	var siblingCount int
	err = prepareScopesTx(ctx, tx, folderPatchScopes(discovered.WorkspaceID, discovered.ParentID, targetParent), func() error {
		locked, err = loadFolderForPrepare(ctx, tx, folderID, true)
		if err != nil {
			return err
		}
		if err := s.requireMutatingRole(ctx, tx, userID, locked.WorkspaceID); err != nil {
			return err
		}
		if err := lockFolderParentForPrepare(ctx, tx, locked.WorkspaceID, targetParent); err != nil {
			return err
		}
		if err := s.ensureFolderNotDescendant(ctx, tx, locked.ID, targetParent); err != nil {
			return err
		}
		siblingCount, err = lockFolderSiblingsForPrepare(ctx, tx, locked.WorkspaceID, targetParent, locked.ID)
		return err
	}, func() ([]siblingScopeKey, error) {
		current, err := loadFolderForPrepare(ctx, tx, folderID, false)
		if err != nil {
			return nil, err
		}
		parent := current.ParentID
		if input.ParentID.Set {
			parent = input.ParentID.Value
		}
		return folderPatchScopes(current.WorkspaceID, current.ParentID, parent), nil
	})
	if err != nil {
		return PreparedFolderPatch{}, err
	}

	name := locked.Name
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
		if name == "" {
			return PreparedFolderPatch{}, fmt.Errorf("folder name is required")
		}
	}
	position := locked.Position
	if input.Position.Set {
		position = input.Position.Value
	} else if !sameOptionalString(locked.ParentID, targetParent) {
		position = siblingCount
	}
	if position < 0 {
		position = 0
	}
	if position > siblingCount {
		position = siblingCount
	}

	original := cloneFolder(locked)
	final := cloneFolder(locked)
	final.ParentID = cloneFolderParent(targetParent)
	final.Name = name
	final.Position = position
	return PreparedFolderPatch{Original: original, Final: final, Fingerprint: folderPatchFingerprint(final), NoOp: foldersEqual(original, final)}, nil
}

func folderPatchScopes(workspaceID string, originalParent, targetParent *string) []siblingScopeKey {
	return []siblingScopeKey{{kind: "folder", workspaceID: workspaceID, parentID: folderScopeParentID(originalParent)}, {kind: "folder", workspaceID: workspaceID, parentID: folderScopeParentID(targetParent)}}
}

func folderScopeParentID(parentID *string) string {
	if parentID == nil {
		return "root"
	}
	return *parentID
}

func loadFolderForPrepare(ctx context.Context, tx pgx.Tx, folderID string, lock bool) (Folder, error) {
	query := `SELECT id, workspace_id, parent_id, name, position, created_at, updated_at FROM folders WHERE id = $1 AND deleted_at IS NULL`
	if lock {
		query += ` FOR UPDATE`
	}
	var folder Folder
	var createdAt, updatedAt time.Time
	err := tx.QueryRow(ctx, query, folderID).Scan(&folder.ID, &folder.WorkspaceID, &folder.ParentID, &folder.Name, &folder.Position, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Folder{}, ErrNotFound
	}
	if err != nil {
		return Folder{}, fmt.Errorf("load folder for preparation: %w", err)
	}
	folder.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	folder.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return folder, nil
}

func lockFolderParentForPrepare(ctx context.Context, tx pgx.Tx, workspaceID string, parentID *string) error {
	if parentID == nil {
		return nil
	}
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE`, *parentID, workspaceID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock folder parent for preparation: %w", err)
	}
	return nil
}

func lockFolderSiblingsForPrepare(ctx context.Context, tx pgx.Tx, workspaceID string, parentID *string, folderID string) (int, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM folders WHERE workspace_id = $1 AND deleted_at IS NULL AND (($2::uuid IS NULL AND parent_id IS NULL) OR parent_id = $2) AND id <> $3::uuid ORDER BY position, id FOR UPDATE`, workspaceID, parentID, folderID)
	if err != nil {
		return 0, fmt.Errorf("lock folder siblings for preparation: %w", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate locked folder siblings: %w", err)
	}
	return count, nil
}

func cloneFolder(folder Folder) Folder {
	folder.ParentID = cloneFolderParent(folder.ParentID)
	return folder
}

func cloneFolderParent(parentID *string) *string {
	if parentID == nil {
		return nil
	}
	copy := *parentID
	return &copy
}

func foldersEqual(left, right Folder) bool {
	return left.ID == right.ID && left.WorkspaceID == right.WorkspaceID && sameOptionalString(left.ParentID, right.ParentID) && left.Name == right.Name && left.Position == right.Position && left.CreatedAt == right.CreatedAt && left.UpdatedAt == right.UpdatedAt
}

func folderPatchFingerprint(folder Folder) string {
	canonical, _ := json.Marshal(struct {
		ID          string  `json:"id"`
		WorkspaceID string  `json:"workspaceId"`
		ParentID    *string `json:"parentId"`
		Name        string  `json:"name"`
		Position    int     `json:"position"`
		CreatedAt   string  `json:"createdAt"`
		UpdatedAt   string  `json:"updatedAt"`
	}{folder.ID, folder.WorkspaceID, folder.ParentID, folder.Name, folder.Position, folder.CreatedAt, folder.UpdatedAt})
	sum := sha256.Sum256(canonical)
	return fmt.Sprintf("%x", sum)
}

// PrepareBookmarkPatchTx authenticates, locks, and normalizes a bookmark update
// in the caller-owned transaction. It never changes resource, ordering, event, or cursor state.
func (s *Service) PrepareBookmarkPatchTx(ctx context.Context, tx pgx.Tx, userID, bookmarkID string, input UpdateBookmarkInput) (PreparedBookmarkPatch, error) {
	discovered, err := loadBookmarkForPrepare(ctx, tx, bookmarkID, false)
	if err != nil {
		return PreparedBookmarkPatch{}, err
	}
	targetFolderID := discovered.FolderID
	if input.FolderID.Set && input.FolderID.Value != nil {
		targetFolderID = *input.FolderID.Value
	}

	var locked Bookmark
	var siblingCount int
	err = prepareScopesTx(ctx, tx, bookmarkPatchScopes(discovered.WorkspaceID, discovered.FolderID, targetFolderID), func() error {
		locked, err = loadBookmarkForPrepare(ctx, tx, bookmarkID, true)
		if err != nil {
			return err
		}
		if err := s.requireMutatingRole(ctx, tx, userID, locked.WorkspaceID); err != nil {
			return err
		}
		if err := lockBookmarkFolderForPrepare(ctx, tx, locked.WorkspaceID, targetFolderID); err != nil {
			return err
		}
		siblingCount, err = lockBookmarkSiblingsForPrepare(ctx, tx, locked.WorkspaceID, targetFolderID, locked.ID)
		return err
	}, func() ([]siblingScopeKey, error) {
		current, err := loadBookmarkForPrepare(ctx, tx, bookmarkID, false)
		if err != nil {
			return nil, err
		}
		folderID := current.FolderID
		if input.FolderID.Set && input.FolderID.Value != nil {
			folderID = *input.FolderID.Value
		}
		return bookmarkPatchScopes(current.WorkspaceID, current.FolderID, folderID), nil
	})
	if err != nil {
		return PreparedBookmarkPatch{}, err
	}

	title := locked.Title
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
		if title == "" {
			return PreparedBookmarkPatch{}, fmt.Errorf("bookmark title is required")
		}
	}
	rawURL := locked.URL
	if input.URL != nil {
		rawURL = strings.TrimSpace(*input.URL)
		if err := validateURL(rawURL); err != nil {
			return PreparedBookmarkPatch{}, err
		}
	}
	position := locked.Position
	if input.Position.Set {
		position = input.Position.Value
	} else if locked.FolderID != targetFolderID {
		position = siblingCount
	}
	if position < 0 {
		position = 0
	}
	if position > siblingCount {
		position = siblingCount
	}

	original := cloneBookmark(locked)
	final := cloneBookmark(locked)
	final.FolderID = targetFolderID
	final.Title = title
	final.URL = rawURL
	final.Position = position
	return PreparedBookmarkPatch{Original: original, Final: final, Fingerprint: bookmarkPatchFingerprint(final), NoOp: bookmarksEqual(original, final)}, nil
}

func bookmarkPatchScopes(workspaceID, originalFolderID, targetFolderID string) []siblingScopeKey {
	return []siblingScopeKey{{kind: "bookmark", workspaceID: workspaceID, parentID: originalFolderID}, {kind: "bookmark", workspaceID: workspaceID, parentID: targetFolderID}}
}

func loadBookmarkForPrepare(ctx context.Context, tx pgx.Tx, bookmarkID string, lock bool) (Bookmark, error) {
	query := `SELECT id, workspace_id, folder_id, title, url, position, created_at, updated_at FROM bookmarks WHERE id = $1 AND deleted_at IS NULL`
	if lock {
		query += ` FOR UPDATE`
	}
	var bookmark Bookmark
	var createdAt, updatedAt time.Time
	err := tx.QueryRow(ctx, query, bookmarkID).Scan(&bookmark.ID, &bookmark.WorkspaceID, &bookmark.FolderID, &bookmark.Title, &bookmark.URL, &bookmark.Position, &createdAt, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Bookmark{}, ErrNotFound
	}
	if err != nil {
		return Bookmark{}, fmt.Errorf("load bookmark for preparation: %w", err)
	}
	bookmark.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	bookmark.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	return bookmark, nil
}

func lockBookmarkFolderForPrepare(ctx context.Context, tx pgx.Tx, workspaceID, folderID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE`, folderID, workspaceID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock bookmark folder for preparation: %w", err)
	}
	return nil
}

func lockBookmarkSiblingsForPrepare(ctx context.Context, tx pgx.Tx, workspaceID, folderID, bookmarkID string) (int, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM bookmarks WHERE workspace_id = $1 AND folder_id = $2 AND deleted_at IS NULL AND id <> $3::uuid ORDER BY position, id FOR UPDATE`, workspaceID, folderID, bookmarkID)
	if err != nil {
		return 0, fmt.Errorf("lock bookmark siblings for preparation: %w", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate locked bookmark siblings: %w", err)
	}
	return count, nil
}

func cloneBookmark(bookmark Bookmark) Bookmark {
	return bookmark
}

func bookmarksEqual(left, right Bookmark) bool {
	return left.ID == right.ID && left.WorkspaceID == right.WorkspaceID && left.FolderID == right.FolderID && left.Title == right.Title && left.URL == right.URL && left.Position == right.Position && left.CreatedAt == right.CreatedAt && left.UpdatedAt == right.UpdatedAt
}

func bookmarkPatchFingerprint(bookmark Bookmark) string {
	canonical, _ := json.Marshal(struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspaceId"`
		FolderID    string `json:"folderId"`
		Title       string `json:"title"`
		URL         string `json:"url"`
		Position    int    `json:"position"`
		CreatedAt   string `json:"createdAt"`
		UpdatedAt   string `json:"updatedAt"`
	}{bookmark.ID, bookmark.WorkspaceID, bookmark.FolderID, bookmark.Title, bookmark.URL, bookmark.Position, bookmark.CreatedAt, bookmark.UpdatedAt})
	sum := sha256.Sum256(canonical)
	return fmt.Sprintf("%x", sum)
}

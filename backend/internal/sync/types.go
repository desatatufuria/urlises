package syncapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/jackc/pgx/v5"
)

const (
	HeaderEventID    = "X-Sync-Event-Id"
	HeaderBaseCursor = "X-Sync-Base-Cursor"
	HeaderCursor     = "X-Sync-Cursor"
	HeaderDuplicate  = "X-Sync-Duplicate"
)

var ErrResyncRequired = errors.New("resync_required")

type Metadata struct {
	EventID        string
	OriginClientID string
	BaseCursor     *int64
}

type Envelope struct {
	Cursor         int64           `json:"cursor"`
	EventID        string          `json:"eventId"`
	WorkspaceID    string          `json:"workspaceId"`
	OriginClientID string          `json:"originClientId"`
	Kind           string          `json:"kind"`
	EntityType     string          `json:"entityType"`
	EntityID       string          `json:"entityId"`
	Payload        json.RawMessage `json:"payload"`
	CreatedAt      string          `json:"createdAt"`
}

type ReplayResult struct {
	Events         []Envelope `json:"events"`
	CurrentCursor  int64      `json:"currentCursor"`
	ResyncRequired bool       `json:"resyncRequired,omitempty"`
}

type MutationResult[T any] struct {
	Resource  T
	Event     Envelope
	Duplicate bool
}

type Publisher interface {
	Publish(context.Context, Envelope) error
}

// PostCommit carries publisher work that the transaction owner may invoke only
// after committing its caller-owned transaction.
type PostCommit struct {
	Publisher Publisher
	Event     Envelope
}

type PreparedMutationResult[T any] struct {
	Resource   T
	Event      *Envelope
	PostCommit *PostCommit
}

type DeleteResult struct {
	Event     Envelope
	Duplicate bool
}

type Store interface {
	CreateFolder(ctx context.Context, userID, workspaceID string, input bookmarks.CreateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error)
	UpdateFolder(ctx context.Context, userID, folderID string, input bookmarks.UpdateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error)
	DeleteFolder(ctx context.Context, userID, folderID string, metadata Metadata) (DeleteResult, error)
	CreateBookmark(ctx context.Context, userID, workspaceID string, input bookmarks.CreateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error)
	UpdateBookmark(ctx context.Context, userID, bookmarkID string, input bookmarks.UpdateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error)
	PrepareFolderPatchTx(ctx context.Context, tx pgx.Tx, userID, folderID string, input bookmarks.UpdateFolderInput) (bookmarks.PreparedFolderPatch, error)
	ApplyPreparedFolderPatchTx(ctx context.Context, tx pgx.Tx, userID string, patch bookmarks.PreparedFolderPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Folder], error)
	ApplyPreparedBookmarkPatchTx(ctx context.Context, tx pgx.Tx, userID string, patch bookmarks.PreparedBookmarkPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Bookmark], error)
	DeleteBookmark(ctx context.Context, userID, bookmarkID string, metadata Metadata) (DeleteResult, error)
	ReplayEvents(ctx context.Context, userID, workspaceID string, afterCursor int64) (ReplayResult, error)
	CurrentCursor(ctx context.Context, workspaceID string) (int64, error)
}

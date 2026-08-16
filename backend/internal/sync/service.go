package syncapi

import (
	"context"

	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/jackc/pgx/v5"
)

type Service struct {
	store Store
}

func NewService(store Store) *Service {
	return &Service{store: store}
}

func (s *Service) CreateFolder(ctx context.Context, userID, workspaceID string, input bookmarks.CreateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error) {
	return s.store.CreateFolder(ctx, userID, workspaceID, input, metadata)
}

func (s *Service) UpdateFolder(ctx context.Context, userID, folderID string, input bookmarks.UpdateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error) {
	return s.store.UpdateFolder(ctx, userID, folderID, input, metadata)
}

func (s *Service) DeleteFolder(ctx context.Context, userID, folderID string, metadata Metadata) (DeleteResult, error) {
	return s.store.DeleteFolder(ctx, userID, folderID, metadata)
}

func (s *Service) CreateBookmark(ctx context.Context, userID, workspaceID string, input bookmarks.CreateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return s.store.CreateBookmark(ctx, userID, workspaceID, input, metadata)
}

func (s *Service) UpdateBookmark(ctx context.Context, userID, bookmarkID string, input bookmarks.UpdateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return s.store.UpdateBookmark(ctx, userID, bookmarkID, input, metadata)
}

func (s *Service) ApplyPreparedFolderPatchTx(ctx context.Context, tx pgx.Tx, userID string, patch bookmarks.PreparedFolderPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Folder], error) {
	return s.store.ApplyPreparedFolderPatchTx(ctx, tx, userID, patch, metadata)
}

func (s *Service) ApplyPreparedBookmarkPatchTx(ctx context.Context, tx pgx.Tx, userID string, patch bookmarks.PreparedBookmarkPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Bookmark], error) {
	return s.store.ApplyPreparedBookmarkPatchTx(ctx, tx, userID, patch, metadata)
}

func (s *Service) DeleteBookmark(ctx context.Context, userID, bookmarkID string, metadata Metadata) (DeleteResult, error) {
	return s.store.DeleteBookmark(ctx, userID, bookmarkID, metadata)
}

func (s *Service) ReplayEvents(ctx context.Context, userID, workspaceID string, afterCursor int64) (ReplayResult, error) {
	return s.store.ReplayEvents(ctx, userID, workspaceID, afterCursor)
}

func (s *Service) CurrentCursor(ctx context.Context, workspaceID string) (int64, error) {
	return s.store.CurrentCursor(ctx, workspaceID)
}

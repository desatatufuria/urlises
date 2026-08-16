package syncapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/jackc/pgx/v5"
)

func RegisterBookmarkRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service, executor *httpapi.IdempotencyExecutor) {
	mux.Handle("POST /workspaces/{workspaceId}/folders", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		metadata, err := MetadataFromRequest(r, principal)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		var input bookmarks.CreateFolderInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		result, err := service.CreateFolder(r.Context(), principal.UserID, r.PathValue("workspaceId"), input, metadata)
		if err != nil {
			writeMutationError(w, err)
			return
		}

		ApplyResponseHeaders(w, result.Event, result.Duplicate)
		httpapi.WriteJSON(w, http.StatusCreated, result.Resource)
	})))

	mux.Handle("PATCH /folders/{folderId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		metadata, err := MetadataFromRequest(r, principal)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		var input bookmarks.UpdateFolderInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		result, _, postCommit, err := executor.ExecutePrepared(r.Context(), httpapi.IdempotencyScope{PrincipalID: principal.UserID, Method: r.Method, Route: "PATCH /folders/{folderId}", Key: metadata.EventID}, func(ctx context.Context, tx pgx.Tx) (httpapi.Prepared, error) {
			patch, err := service.PrepareFolderPatchTx(ctx, tx, principal.UserID, r.PathValue("folderId"), input)
			if err != nil {
				return httpapi.Prepared{}, err
			}
			fingerprint, err := preparedFolderFingerprint(patch.Final)
			if err != nil {
				return httpapi.Prepared{}, err
			}
			return httpapi.Prepared{Fingerprint: fingerprint, Command: func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, httpapi.PostCommit, error) {
				applied, err := service.ApplyPreparedFolderPatchTx(ctx, tx, principal.UserID, patch, metadata)
				if err != nil {
					return httpapi.SafeResult{}, nil, err
				}
				headers := map[string]string{HeaderEventID: metadata.EventID, HeaderDuplicate: "false"}
				var ackCursor *int64
				if applied.Event != nil {
					ackCursor = &applied.Event.Cursor
					headers[HeaderCursor] = strconv.FormatInt(*ackCursor, 10)
				}
				return httpapi.SafeResult{Status: http.StatusOK, Body: safeFolderBody(applied.Resource), Headers: headers, AckCursor: ackCursor}, preparedPostCommit(applied.PostCommit), nil
			}}, nil
		})
		if err != nil {
			writeMutationError(w, err)
			return
		}

		if postCommit != nil {
			if err := postCommit(r.Context()); err != nil {
				writeMutationError(w, err)
				return
			}
		}
		ApplyStoredResponseHeaders(w, result.Headers)
		httpapi.WriteJSON(w, result.Status, result.Body)
	})))

	mux.Handle("DELETE /folders/{folderId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		metadata, err := MetadataFromRequest(r, principal)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		result, err := service.DeleteFolder(r.Context(), principal.UserID, r.PathValue("folderId"), metadata)
		if err != nil {
			writeMutationError(w, err)
			return
		}

		ApplyResponseHeaders(w, result.Event, result.Duplicate)
		w.WriteHeader(http.StatusNoContent)
	})))

	mux.Handle("POST /workspaces/{workspaceId}/bookmarks", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		metadata, err := MetadataFromRequest(r, principal)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		var input bookmarks.CreateBookmarkInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		result, err := service.CreateBookmark(r.Context(), principal.UserID, r.PathValue("workspaceId"), input, metadata)
		if err != nil {
			writeMutationError(w, err)
			return
		}

		ApplyResponseHeaders(w, result.Event, result.Duplicate)
		httpapi.WriteJSON(w, http.StatusCreated, result.Resource)
	})))

	mux.Handle("PATCH /bookmarks/{bookmarkId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		metadata, err := MetadataFromRequest(r, principal)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		var input bookmarks.UpdateBookmarkInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		result, _, postCommit, err := executor.ExecutePrepared(r.Context(), httpapi.IdempotencyScope{PrincipalID: principal.UserID, Method: r.Method, Route: "PATCH /bookmarks/{bookmarkId}", Key: metadata.EventID}, func(ctx context.Context, tx pgx.Tx) (httpapi.Prepared, error) {
			patch, err := service.PrepareBookmarkPatchTx(ctx, tx, principal.UserID, r.PathValue("bookmarkId"), input)
			if err != nil {
				return httpapi.Prepared{}, err
			}
			fingerprint, err := preparedBookmarkFingerprint(patch.Final)
			if err != nil {
				return httpapi.Prepared{}, err
			}
			return httpapi.Prepared{Fingerprint: fingerprint, Command: func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, httpapi.PostCommit, error) {
				applied, err := service.ApplyPreparedBookmarkPatchTx(ctx, tx, principal.UserID, patch, metadata)
				if err != nil {
					return httpapi.SafeResult{}, nil, err
				}
				headers := map[string]string{HeaderEventID: metadata.EventID, HeaderDuplicate: "false"}
				var ackCursor *int64
				if applied.Event != nil {
					ackCursor = &applied.Event.Cursor
					headers[HeaderCursor] = strconv.FormatInt(*ackCursor, 10)
				}
				return httpapi.SafeResult{Status: http.StatusOK, Body: safeBookmarkBody(applied.Resource), Headers: headers, AckCursor: ackCursor}, preparedPostCommit(applied.PostCommit), nil
			}}, nil
		})
		if err != nil {
			writeMutationError(w, err)
			return
		}

		if postCommit != nil {
			if err := postCommit(r.Context()); err != nil {
				writeMutationError(w, err)
				return
			}
		}
		ApplyStoredResponseHeaders(w, result.Headers)
		httpapi.WriteJSON(w, result.Status, result.Body)
	})))

	mux.Handle("DELETE /bookmarks/{bookmarkId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		metadata, err := MetadataFromRequest(r, principal)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		result, err := service.DeleteBookmark(r.Context(), principal.UserID, r.PathValue("bookmarkId"), metadata)
		if err != nil {
			writeMutationError(w, err)
			return
		}

		ApplyResponseHeaders(w, result.Event, result.Duplicate)
		w.WriteHeader(http.StatusNoContent)
	})))
}

func writeMutationError(w http.ResponseWriter, err error) {
	bookmarksErrWriter(w, err)
}

func preparedPostCommit(postCommit *PostCommit) httpapi.PostCommit {
	if postCommit == nil || postCommit.Publisher == nil {
		return nil
	}
	return func(ctx context.Context) error { return postCommit.Publisher.Publish(ctx, postCommit.Event) }
}

func safeFolderBody(folder bookmarks.Folder) map[string]any {
	body := map[string]any{"id": folder.ID, "workspaceId": folder.WorkspaceID, "name": folder.Name, "position": folder.Position, "createdAt": folder.CreatedAt, "updatedAt": folder.UpdatedAt}
	if folder.ParentID != nil {
		body["parentId"] = *folder.ParentID
	}
	return body
}

func safeBookmarkBody(bookmark bookmarks.Bookmark) map[string]any {
	return map[string]any{"id": bookmark.ID, "workspaceId": bookmark.WorkspaceID, "folderId": bookmark.FolderID, "title": bookmark.Title, "url": bookmark.URL, "position": bookmark.Position, "createdAt": bookmark.CreatedAt, "updatedAt": bookmark.UpdatedAt}
}

func preparedFolderFingerprint(folder bookmarks.Folder) (string, error) {
	return httpapi.CanonicalTargetFingerprint("PATCH /folders/{folderId}", []string{folder.ID}, map[string]any{
		"workspaceId": folder.WorkspaceID,
		"parentId":    folder.ParentID,
		"name":        folder.Name,
		"position":    folder.Position,
	})
}

func preparedBookmarkFingerprint(bookmark bookmarks.Bookmark) (string, error) {
	return httpapi.CanonicalTargetFingerprint("PATCH /bookmarks/{bookmarkId}", []string{bookmark.ID}, map[string]any{
		"workspaceId": bookmark.WorkspaceID,
		"folderId":    bookmark.FolderID,
		"title":       bookmark.Title,
		"url":         bookmark.URL,
		"position":    bookmark.Position,
	})
}

func bookmarksErrWriter(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, bookmarks.ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, bookmarks.ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

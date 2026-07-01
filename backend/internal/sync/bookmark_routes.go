package syncapi

import (
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

func RegisterBookmarkRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service) {
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

		result, err := service.UpdateFolder(r.Context(), principal.UserID, r.PathValue("folderId"), input, metadata)
		if err != nil {
			writeMutationError(w, err)
			return
		}

		ApplyResponseHeaders(w, result.Event, result.Duplicate)
		httpapi.WriteJSON(w, http.StatusOK, result.Resource)
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

		result, err := service.UpdateBookmark(r.Context(), principal.UserID, r.PathValue("bookmarkId"), input, metadata)
		if err != nil {
			writeMutationError(w, err)
			return
		}

		ApplyResponseHeaders(w, result.Event, result.Duplicate)
		httpapi.WriteJSON(w, http.StatusOK, result.Resource)
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

func bookmarksErrWriter(w http.ResponseWriter, err error) {
	switch {
	case err == bookmarks.ErrForbidden:
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case err == bookmarks.ErrNotFound:
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

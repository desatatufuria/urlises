package bookmarks

import (
	"errors"
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service) {
	mux.Handle("POST /workspaces/{workspaceId}/folders", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input CreateFolderInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		folder, err := service.CreateFolder(r.Context(), principal.UserID, r.PathValue("workspaceId"), input)
		if err != nil {
			writeBookmarkError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, folder)
	})))

	mux.Handle("PATCH /folders/{folderId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input UpdateFolderInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		folder, err := service.UpdateFolder(r.Context(), principal.UserID, r.PathValue("folderId"), input)
		if err != nil {
			writeBookmarkError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, folder)
	})))

	mux.Handle("DELETE /folders/{folderId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.DeleteFolder(r.Context(), principal.UserID, r.PathValue("folderId")); err != nil {
			writeBookmarkError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))

	mux.Handle("POST /workspaces/{workspaceId}/bookmarks", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input CreateBookmarkInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		bookmark, err := service.CreateBookmark(r.Context(), principal.UserID, r.PathValue("workspaceId"), input)
		if err != nil {
			writeBookmarkError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, bookmark)
	})))

	mux.Handle("PATCH /bookmarks/{bookmarkId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input UpdateBookmarkInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		bookmark, err := service.UpdateBookmark(r.Context(), principal.UserID, r.PathValue("bookmarkId"), input)
		if err != nil {
			writeBookmarkError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, bookmark)
	})))

	mux.Handle("DELETE /bookmarks/{bookmarkId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.DeleteBookmark(r.Context(), principal.UserID, r.PathValue("bookmarkId")); err != nil {
			writeBookmarkError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))
}

func writeBookmarkError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

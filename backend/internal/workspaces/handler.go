package workspaces

import (
	"errors"
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service) {
	mux.Handle("GET /organizations/{organizationId}/workspaces", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		workspaces, err := service.ListByOrganization(r.Context(), principal.UserID, r.PathValue("organizationId"))
		if err != nil {
			httpapi.WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"workspaces": workspaces})
	})))

	mux.Handle("GET /workspaces/{workspaceId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		workspace, err := service.GetAccessibleWorkspace(r.Context(), principal.UserID, r.PathValue("workspaceId"))
		if err != nil {
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, workspace)
	})))

	mux.Handle("GET /workspaces/{workspaceId}/tree", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		tree, err := service.GetTree(r.Context(), principal.UserID, r.PathValue("workspaceId"))
		if err != nil {
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, tree)
	})))
}

func writeWorkspaceError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrForbidden) {
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
		return
	}

	httpapi.WriteError(w, http.StatusInternalServerError, err.Error())
}

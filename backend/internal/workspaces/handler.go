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
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"workspaces": workspaces})
	})))

	mux.Handle("POST /organizations/{organizationId}/workspaces", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input CreateWorkspaceInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		workspace, err := service.Create(r.Context(), principal.UserID, r.PathValue("organizationId"), input)
		if err != nil {
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, workspace)
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

	mux.Handle("PUT /workspaces/{workspaceId}/users/{userId}/access", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input UpdateUserAccessInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		grant, err := service.GrantUserAccess(r.Context(), principal.UserID, r.PathValue("workspaceId"), r.PathValue("userId"), input)
		if err != nil {
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, grant)
	})))

	mux.Handle("DELETE /workspaces/{workspaceId}/users/{userId}/access", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.RevokeUserAccess(r.Context(), principal.UserID, r.PathValue("workspaceId"), r.PathValue("userId")); err != nil {
			writeWorkspaceError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))

	mux.Handle("PUT /workspaces/{workspaceId}/groups/{groupId}/access", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input UpdateGroupAccessInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		grant, err := service.GrantGroupAccess(r.Context(), principal.UserID, r.PathValue("workspaceId"), r.PathValue("groupId"), input)
		if err != nil {
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, grant)
	})))

	mux.Handle("DELETE /workspaces/{workspaceId}/groups/{groupId}/access", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.RevokeGroupAccess(r.Context(), principal.UserID, r.PathValue("workspaceId"), r.PathValue("groupId")); err != nil {
			writeWorkspaceError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))
}

func writeWorkspaceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

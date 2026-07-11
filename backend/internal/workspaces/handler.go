package workspaces

import (
	"context"
	"errors"
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/jackc/pgx/v5"
)

type routeService interface {
	ListByOrganization(context.Context, string, string) ([]WorkspaceAccess, error)
	Create(context.Context, string, string, CreateWorkspaceInput) (WorkspaceAccess, error)
	GetAccessibleWorkspace(context.Context, string, string) (WorkspaceAccess, error)
	GetTree(context.Context, string, string) (TreeResponse, error)
	GetAccessSnapshot(context.Context, string, string) (WorkspaceAccessSnapshot, error)
	GrantUserAccess(context.Context, string, string, string, UpdateUserAccessInput) (UserAccessGrant, error)
	RevokeUserAccess(context.Context, string, string, string) error
	GrantGroupAccess(context.Context, string, string, string, UpdateGroupAccessInput) (GroupAccessGrant, error)
	RevokeGroupAccess(context.Context, string, string, string) error
}

type creationTxService interface {
	AuthorizeCreateTx(context.Context, pgx.Tx, string, string) error
	CreateTx(context.Context, pgx.Tx, string, string, CreateWorkspaceInput) (WorkspaceAccess, error)
}

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, executors ...*httpapi.IdempotencyExecutor) {
	var executor *httpapi.IdempotencyExecutor
	if len(executors) > 0 {
		executor = executors[0]
	}
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

		if executor != nil {
			if r.Header.Get("Idempotency-Key") == "" {
				httpapi.WriteError(w, http.StatusBadRequest, "invalid idempotency key")
				return
			}
			txService, ok := service.(creationTxService)
			if !ok {
				httpapi.WriteError(w, 500, "internal server error")
				return
			}
			organizationID := r.PathValue("organizationId")
			targets := []string{organizationID}
			fingerprint, _ := httpapi.CanonicalTargetFingerprint("POST /organizations/{organizationId}/workspaces", targets, input)
			result, _, err := executor.Execute(r.Context(), httpapi.IdempotencyIdentity{PrincipalID: principal.UserID, Method: r.Method, Route: "POST /organizations/{organizationId}/workspaces|" + organizationID, Key: r.Header.Get("Idempotency-Key"), Fingerprint: fingerprint}, func(ctx context.Context, tx pgx.Tx) error {
				return txService.AuthorizeCreateTx(ctx, tx, principal.UserID, organizationID)
			}, func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, error) {
				workspace, err := txService.CreateTx(ctx, tx, principal.UserID, organizationID, input)
				return httpapi.SafeResult{Status: 201, Body: workspace}, err
			})
			if err != nil {
				writeWorkspaceIdempotencyError(w, err)
				return
			}
			httpapi.WriteJSON(w, result.Status, result.Body)
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

	mux.Handle("GET /workspaces/{workspaceId}/access", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		accessSnapshot, err := service.GetAccessSnapshot(r.Context(), principal.UserID, r.PathValue("workspaceId"))
		if err != nil {
			writeWorkspaceError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, accessSnapshot)
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
func writeWorkspaceIdempotencyError(w http.ResponseWriter, err error) {
	if errors.Is(err, httpapi.ErrIdempotencyKeyConflict) || errors.Is(err, httpapi.ErrIdempotencyInProgress) {
		httpapi.WriteError(w, 409, err.Error())
		return
	}
	if err.Error() == "invalid idempotency key" {
		httpapi.WriteError(w, 400, "invalid idempotency key")
		return
	}
	writeWorkspaceError(w, err)
}

func writeWorkspaceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
	}
}

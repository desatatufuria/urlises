package groups

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/jackc/pgx/v5"
)

type routeService interface {
	List(context.Context, string, string) ([]Group, error)
	Create(context.Context, string, string, CreateGroupInput) (Group, error)
	Update(context.Context, string, string, string, UpdateGroupInput) (Group, error)
	Delete(context.Context, string, string, string) error
	AddMember(context.Context, string, string, AddGroupMemberInput) (GroupMember, error)
	ListMembers(context.Context, string, string) ([]GroupMember, error)
	RemoveMember(context.Context, string, string, string) error
}

type creationTxService interface {
	AuthorizeCreateTx(context.Context, pgx.Tx, string, string) error
	AuthorizeAddMemberTx(context.Context, pgx.Tx, string, string) error
	CreateTx(context.Context, pgx.Tx, string, string, CreateGroupInput) (Group, error)
	AddMemberTx(context.Context, pgx.Tx, string, string, AddGroupMemberInput) (GroupMember, error)
}

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, executors ...*httpapi.IdempotencyExecutor) {
	var executor *httpapi.IdempotencyExecutor
	if len(executors) > 0 {
		executor = executors[0]
	}
	mux.Handle("GET /organizations/{organizationId}/groups", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		groups, err := service.List(r.Context(), principal.UserID, r.PathValue("organizationId"))
		if err != nil {
			writeGroupError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"groups": groups})
	})))

	mux.Handle("POST /organizations/{organizationId}/groups", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input CreateGroupInput
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
			result, _, err := executor.Execute(r.Context(), groupIdentity(r, principal.UserID, "POST /organizations/{organizationId}/groups", []string{organizationID}, input), func(ctx context.Context, tx pgx.Tx) error {
				return txService.AuthorizeCreateTx(ctx, tx, principal.UserID, organizationID)
			}, func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, error) {
				group, err := txService.CreateTx(ctx, tx, principal.UserID, organizationID, input)
				return httpapi.SafeResult{Status: 201, Body: group}, err
			})
			if err != nil {
				writeGroupIdempotencyError(w, err)
				return
			}
			httpapi.WriteJSON(w, result.Status, result.Body)
			return
		}
		group, err := service.Create(r.Context(), principal.UserID, r.PathValue("organizationId"), input)
		if err != nil {
			writeGroupError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, group)
	})))

	mux.Handle("PATCH /organizations/{organizationId}/groups/{groupId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input UpdateGroupInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		group, err := service.Update(r.Context(), principal.UserID, r.PathValue("organizationId"), r.PathValue("groupId"), input)
		if err != nil {
			writeGroupError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, group)
	})))

	mux.Handle("DELETE /organizations/{organizationId}/groups/{groupId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.Delete(r.Context(), principal.UserID, r.PathValue("organizationId"), r.PathValue("groupId")); err != nil {
			writeGroupError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))

	mux.Handle("POST /groups/{groupId}/members", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input AddGroupMemberInput
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
			groupID := r.PathValue("groupId")
			result, _, err := executor.Execute(r.Context(), groupIdentity(r, principal.UserID, "POST /groups/{groupId}/members", []string{groupID}, input), func(ctx context.Context, tx pgx.Tx) error {
				return txService.AuthorizeAddMemberTx(ctx, tx, principal.UserID, groupID)
			}, func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, error) {
				member, err := txService.AddMemberTx(ctx, tx, principal.UserID, groupID, input)
				return httpapi.SafeResult{Status: 201, Body: member}, err
			})
			if err != nil {
				writeGroupIdempotencyError(w, err)
				return
			}
			httpapi.WriteJSON(w, result.Status, result.Body)
			return
		}
		member, err := service.AddMember(r.Context(), principal.UserID, r.PathValue("groupId"), input)
		if err != nil {
			writeGroupError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, member)
	})))

	mux.Handle("GET /groups/{groupId}/members", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		members, err := service.ListMembers(r.Context(), principal.UserID, r.PathValue("groupId"))
		if err != nil {
			writeGroupError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"members": members})
	})))

	mux.Handle("DELETE /groups/{groupId}/members/{userId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.RemoveMember(r.Context(), principal.UserID, r.PathValue("groupId"), r.PathValue("userId")); err != nil {
			writeGroupError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))
}
func groupIdentity(r *http.Request, principal, route string, targets []string, input any) httpapi.IdempotencyIdentity {
	fingerprint, _ := httpapi.CanonicalTargetFingerprint(route, targets, input)
	return httpapi.IdempotencyIdentity{PrincipalID: principal, Method: r.Method, Route: route + "|" + strings.Join(targets, ","), Key: r.Header.Get("Idempotency-Key"), Fingerprint: fingerprint}
}
func writeGroupIdempotencyError(w http.ResponseWriter, err error) {
	if errors.Is(err, httpapi.ErrIdempotencyKeyConflict) || errors.Is(err, httpapi.ErrIdempotencyInProgress) {
		httpapi.WriteError(w, 409, err.Error())
		return
	}
	if err.Error() == "invalid idempotency key" {
		httpapi.WriteError(w, 400, "invalid idempotency key")
		return
	}
	writeGroupError(w, err)
}

func writeGroupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
	}
}

package organizations

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
	ListMemberships(context.Context, string) ([]Membership, error)
	CreateOrganization(context.Context, string, CreateOrganizationInput) (Membership, error)
	ListMembers(context.Context, string, string) ([]OrganizationMember, error)
	PatchMember(context.Context, string, string, PatchMemberInput) (OrganizationMember, error)
	CreateInvitation(context.Context, string, string, CreateInvitationInput) (Invitation, error)
	ListInvitations(context.Context, string, string) ([]PendingInvitation, error)
}

type creationTxService interface {
	AuthorizeOrganizationCreationTx(context.Context, pgx.Tx, string) error
	AuthorizeInvitationTx(context.Context, pgx.Tx, string, string) error
	CreateOrganizationTx(context.Context, pgx.Tx, string, CreateOrganizationInput) (Membership, error)
	CreateInvitationTx(context.Context, pgx.Tx, string, string, CreateInvitationInput) (Invitation, error)
}

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, executors ...*httpapi.IdempotencyExecutor) {
	var executor *httpapi.IdempotencyExecutor
	if len(executors) > 0 {
		executor = executors[0]
	}
	mux.Handle("GET /organizations", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		memberships, err := service.ListMemberships(r.Context(), principal.UserID)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"organizations": memberships})
	})))

	mux.Handle("POST /organizations", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input CreateOrganizationInput
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
				httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			result, _, err := executor.Execute(r.Context(), idempotencyIdentity(r, principal.UserID, "POST /organizations", nil, input), func(ctx context.Context, tx pgx.Tx) error {
				return txService.AuthorizeOrganizationCreationTx(ctx, tx, principal.UserID)
			}, func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, error) {
				membership, err := txService.CreateOrganizationTx(ctx, tx, principal.UserID, input)
				return httpapi.SafeResult{Status: http.StatusCreated, Body: organizationCreation(membership)}, err
			})
			if err != nil {
				writeIdempotencyError(w, err, writeOrganizationError)
				return
			}
			httpapi.WriteJSON(w, result.Status, result.Body)
			return
		}
		membership, err := service.CreateOrganization(r.Context(), principal.UserID, input)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, membership)
	})))

	mux.Handle("GET /organizations/{organizationId}/members", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		members, err := service.ListMembers(r.Context(), principal.UserID, r.PathValue("organizationId"))
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"members": members})
	})))

	mux.Handle("PATCH /organizations/{organizationId}/members", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input PatchMemberInput
		if err := httpapi.DecodeJSON(r, &input); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		member, err := service.PatchMember(r.Context(), principal.UserID, r.PathValue("organizationId"), input)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		if input.Remove {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, member)
	})))

	mux.Handle("POST /organizations/{organizationId}/invitations", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		var input CreateInvitationInput
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
				httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			organizationID := r.PathValue("organizationId")
			result, _, err := executor.Execute(r.Context(), idempotencyIdentity(r, principal.UserID, "POST /organizations/{organizationId}/invitations", []string{organizationID}, input), func(ctx context.Context, tx pgx.Tx) error {
				return txService.AuthorizeInvitationTx(ctx, tx, principal.UserID, organizationID)
			}, func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, error) {
				invitation, err := txService.CreateInvitationTx(ctx, tx, principal.UserID, organizationID, input)
				return httpapi.SafeResult{Status: http.StatusCreated, Body: invitationCreation(invitation)}, err
			})
			if err != nil {
				writeIdempotencyError(w, err, writeOrganizationError)
				return
			}
			httpapi.WriteJSON(w, result.Status, result.Body)
			return
		}
		invitation, err := service.CreateInvitation(r.Context(), principal.UserID, r.PathValue("organizationId"), input)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, invitation)
	})))

	mux.Handle("GET /organizations/{organizationId}/invitations", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		invitations, err := service.ListInvitations(r.Context(), principal.UserID, r.PathValue("organizationId"))
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"invitations": invitations})
	})))
}

func idempotencyIdentity(r *http.Request, principal, route string, targets []string, input any) httpapi.IdempotencyIdentity {
	fingerprint, _ := httpapi.CanonicalTargetFingerprint(route, targets, input)
	return httpapi.IdempotencyIdentity{PrincipalID: principal, Method: r.Method, Route: route + "|" + strings.Join(targets, ","), Key: r.Header.Get("Idempotency-Key"), Fingerprint: fingerprint}
}
func writeIdempotencyError(w http.ResponseWriter, err error, writeDomain func(http.ResponseWriter, error)) {
	switch {
	case errors.Is(err, httpapi.ErrIdempotencyKeyConflict), errors.Is(err, httpapi.ErrIdempotencyInProgress):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	case err.Error() == "invalid idempotency key":
		httpapi.WriteError(w, http.StatusBadRequest, "invalid idempotency key")
	default:
		writeDomain(w, err)
	}
}
func organizationCreation(m Membership) map[string]string {
	return map[string]string{"organizationId": m.OrganizationID, "organizationName": m.OrganizationName, "role": m.Role}
}
func invitationCreation(i Invitation) map[string]any {
	return map[string]any{"id": i.ID, "organizationId": i.OrganizationID, "email": i.Email, "role": i.Role, "status": i.Status, "invitedByUserId": i.InvitedByUserID, "acceptedByUserId": i.AcceptedByUserID, "expiresAt": i.ExpiresAt, "acceptedAt": i.AcceptedAt, "createdAt": i.CreatedAt, "updatedAt": i.UpdatedAt}
}

func writeOrganizationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrLastOwner):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrInvalidInvitationEmail), err.Error() == ErrInvalidInvitationEmail.Error():
		httpapi.WriteError(w, http.StatusBadRequest, ErrInvalidInvitationEmail.Error())
	case errors.Is(err, ErrInvitationMemberExists), err.Error() == ErrInvitationMemberExists.Error():
		httpapi.WriteError(w, http.StatusConflict, ErrInvitationMemberExists.Error())
	case errors.Is(err, ErrInvitationPendingExists), err.Error() == ErrInvitationPendingExists.Error():
		httpapi.WriteError(w, http.StatusConflict, ErrInvitationPendingExists.Error())
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
	}
}

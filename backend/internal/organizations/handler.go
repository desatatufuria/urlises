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
	CreateInvitation(context.Context, string, string, CreateInvitationInput) (InvitationCreation, error)
	ListInvitations(context.Context, string, string) ([]PendingInvitation, error)
	ResendInvitation(ctx context.Context, requesterUserID, organizationID, invitationID string) (InvitationCreation, error)
	CancelInvitation(ctx context.Context, requesterUserID, organizationID, invitationID string) error
	DeleteOrganization(ctx context.Context, requesterUserID, organizationID string) error
}

type creationTxService interface {
	AuthorizeOrganizationCreationTx(context.Context, pgx.Tx, string) error
	AuthorizeInvitationTx(context.Context, pgx.Tx, string, string) error
	CreateOrganizationTx(context.Context, pgx.Tx, string, CreateOrganizationInput) (Membership, error)
	CreateInvitationTx(context.Context, pgx.Tx, string, string, CreateInvitationInput) (InvitationCreation, error)
}

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, notifier invitationNotifier, executors ...*httpapi.IdempotencyExecutor) {
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
			identity := idempotencyIdentity(r, principal.UserID, "POST /organizations/{organizationId}/invitations", []string{organizationID}, input)
			result, _, hook, err := executor.ExecutePrepared(r.Context(), idempotencyScope(identity), func(ctx context.Context, tx pgx.Tx) (httpapi.Prepared, error) {
				if err := txService.AuthorizeInvitationTx(ctx, tx, principal.UserID, organizationID); err != nil {
					return httpapi.Prepared{}, err
				}
				return httpapi.Prepared{Fingerprint: identity.Fingerprint, Command: func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, httpapi.PostCommit, error) {
					created, err := txService.CreateInvitationTx(ctx, tx, principal.UserID, organizationID, input)
					if err != nil {
						return httpapi.SafeResult{}, nil, err
					}
					var post httpapi.PostCommit
					if notifier != nil {
						notification := invitationNotification(created)
						post = func(ctx context.Context) error { return notifier.NotifyInvitation(ctx, notification) }
					}
					return httpapi.SafeResult{Status: http.StatusCreated, Body: invitationCreation(created.Invitation)}, post, nil
				}}, nil
			})
			if err != nil {
				writeIdempotencyError(w, err, writeOrganizationError)
				return
			}
			httpapi.WriteJSON(w, result.Status, result.Body)
			if hook != nil {
				_ = http.NewResponseController(w).Flush()
				_ = hook(context.WithoutCancel(r.Context()))
			}
			return
		}
		created, err := service.CreateInvitation(r.Context(), principal.UserID, r.PathValue("organizationId"), input)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, created.Invitation)
		if notifier != nil {
			_ = http.NewResponseController(w).Flush()
			_ = notifier.NotifyInvitation(context.WithoutCancel(r.Context()), invitationNotification(created))
		}
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

	mux.Handle("POST /organizations/{organizationId}/invitations/{invitationId}/resend", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		resent, err := service.ResendInvitation(r.Context(), principal.UserID, r.PathValue("organizationId"), r.PathValue("invitationId"))
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, pendingInvitationView(resent.Invitation))
		if notifier != nil {
			_ = http.NewResponseController(w).Flush()
			_ = notifier.NotifyInvitation(context.WithoutCancel(r.Context()), invitationNotification(resent))
		}
	})))

	mux.Handle("POST /organizations/{organizationId}/invitations/{invitationId}/cancel", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.CancelInvitation(r.Context(), principal.UserID, r.PathValue("organizationId"), r.PathValue("invitationId")); err != nil {
			writeOrganizationError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))

	mux.Handle("DELETE /organizations/{organizationId}", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if err := service.DeleteOrganization(r.Context(), principal.UserID, r.PathValue("organizationId")); err != nil {
			writeOrganizationError(w, err)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})))
}

func idempotencyIdentity(r *http.Request, principal, route string, targets []string, input any) httpapi.IdempotencyIdentity {
	fingerprint, _ := httpapi.CanonicalTargetFingerprint(route, targets, input)
	return httpapi.IdempotencyIdentity{PrincipalID: principal, Method: r.Method, Route: route + "|" + strings.Join(targets, ","), Key: r.Header.Get("Idempotency-Key"), Fingerprint: fingerprint}
}

// idempotencyScope reproduces exactly what Execute builds internally
// (idempotency.go), so scope, fingerprint and route string stay
// byte-identical to before and existing idempotency records stay valid.
func idempotencyScope(identity httpapi.IdempotencyIdentity) httpapi.IdempotencyScope {
	return httpapi.IdempotencyScope{PrincipalID: identity.PrincipalID, Method: identity.Method, Route: identity.Route, Key: identity.Key}
}

func invitationNotification(created InvitationCreation) InvitationNotification {
	return InvitationNotification{
		InvitationID:     created.Invitation.ID,
		OrganizationID:   created.Invitation.OrganizationID,
		OrganizationName: created.OrganizationName,
		InviterEmail:     created.InviterEmail,
		InviterName:      created.InviterName,
		InviteeEmail:     created.Invitation.Email,
		Role:             created.Invitation.Role,
		Token:            created.Invitation.Token,
		ExpiresAt:        created.ExpiresAt,
	}
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
func pendingInvitationView(i Invitation) PendingInvitation {
	return PendingInvitation{
		ID:              i.ID,
		OrganizationID:  i.OrganizationID,
		Email:           i.Email,
		Role:            i.Role,
		Status:          i.Status,
		InvitedByUserID: i.InvitedByUserID,
		ExpiresAt:       i.ExpiresAt,
		CreatedAt:       i.CreatedAt,
		UpdatedAt:       i.UpdatedAt,
	}
}

func writeOrganizationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrLastOwner):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrWouldOrphanMember):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrInvalidInvitationEmail), err.Error() == ErrInvalidInvitationEmail.Error():
		httpapi.WriteError(w, http.StatusBadRequest, ErrInvalidInvitationEmail.Error())
	case errors.Is(err, ErrInvitationMemberExists), err.Error() == ErrInvitationMemberExists.Error():
		httpapi.WriteError(w, http.StatusConflict, ErrInvitationMemberExists.Error())
	case errors.Is(err, ErrInvitationPendingExists), err.Error() == ErrInvitationPendingExists.Error():
		httpapi.WriteError(w, http.StatusConflict, ErrInvitationPendingExists.Error())
	case errors.Is(err, ErrInvitationNotPending), err.Error() == ErrInvitationNotPending.Error():
		httpapi.WriteError(w, http.StatusBadRequest, ErrInvitationNotPending.Error())
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
	}
}

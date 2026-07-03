package organizations

import (
	"errors"
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service) {
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

		invitation, err := service.CreateInvitation(r.Context(), principal.UserID, r.PathValue("organizationId"), input)
		if err != nil {
			writeOrganizationError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, invitation)
	})))
}

func writeOrganizationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrLastOwner):
		httpapi.WriteError(w, http.StatusConflict, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

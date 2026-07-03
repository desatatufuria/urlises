package groups

import (
	"errors"
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service) {
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

		member, err := service.AddMember(r.Context(), principal.UserID, r.PathValue("groupId"), input)
		if err != nil {
			writeGroupError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, member)
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

func writeGroupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, err.Error())
	default:
		httpapi.WriteError(w, http.StatusBadRequest, err.Error())
	}
}

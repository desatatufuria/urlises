package organizations

import (
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
			httpapi.WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"organizations": memberships})
	})))
}

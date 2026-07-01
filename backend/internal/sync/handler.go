package syncapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
)

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service *Service) {
	mux.Handle("GET /sync/events", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
		if workspaceID == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "workspaceId is required")
			return
		}

		afterCursor, err := parseAfterCursor(r)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

			result, err := service.ReplayEvents(r.Context(), principal.UserID, workspaceID, afterCursor)
			if err != nil {
				if errors.Is(err, ErrResyncRequired) {
					httpapi.WriteJSON(w, http.StatusConflict, ReplayResult{CurrentCursor: result.CurrentCursor, ResyncRequired: true})
					return
				}
				if errors.Is(err, workspaces.ErrForbidden) {
					httpapi.WriteError(w, http.StatusForbidden, err.Error())
					return
				}
				httpapi.WriteError(w, http.StatusBadRequest, err.Error())
				return
			}

		httpapi.WriteJSON(w, http.StatusOK, result)
	})))
}

func parseAfterCursor(r *http.Request) (int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("afterCursor"))
	if raw == "" {
		return 0, nil
	}

	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	if value < 0 {
		return 0, errors.New("afterCursor must be zero or greater")
	}

	return value, nil
}

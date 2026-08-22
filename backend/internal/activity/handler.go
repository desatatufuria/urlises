package activity

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

// defaultListLimit is the page size applied when an HTTP caller omits the
// `limit` query param entirely (or supplies a value that isn't a valid
// positive integer). Service.ListByOrganization itself only clamps into
// [1, 100] and does not apply a default -- "default 50 when absent" is this
// handler's responsibility (see design.md's Page Size decision).
const defaultListLimit = 50

// routeService is the subset of *Service the HTTP layer depends on,
// matching groups.routeService's / workspaces.routeService's narrow,
// handler-local interface pattern.
type routeService interface {
	ListByOrganization(ctx context.Context, requesterUserID, organizationID, cursor string, limit int) ([]Event, string, error)
}

// RegisterRoutes registers the activity feed's single read-only,
// authenticated route: GET /organizations/{organizationId}/activity.
func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService) {
	mux.Handle("GET /organizations/{organizationId}/activity", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		limit := parseListLimit(r.URL.Query().Get("limit"))
		cursor := r.URL.Query().Get("cursor")

		events, nextCursor, err := service.ListByOrganization(r.Context(), principal.UserID, r.PathValue("organizationId"), cursor, limit)
		if err != nil {
			writeActivityError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"events": events, "nextCursor": nextCursor})
	})))
}

// parseListLimit resolves the `limit` query param into an int, defaulting
// to defaultListLimit when the param is absent or not a valid positive
// integer. A large or otherwise valid positive value is returned as-is --
// the service layer clamps it to [1, 100], so a malformed/huge value is
// still safely bounded, not just the missing case.
func parseListLimit(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultListLimit
	}

	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return defaultListLimit
	}

	return parsed
}

// writeActivityError maps a ListByOrganization error to the correct HTTP
// status, matching groups.writeGroupError's / workspaces.writeWorkspaceError's
// switch-on-sentinel-error pattern.
func writeActivityError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, access.ErrForbidden):
		httpapi.WriteError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrMalformedCursor):
		httpapi.WriteError(w, http.StatusBadRequest, "invalid cursor")
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
	}
}

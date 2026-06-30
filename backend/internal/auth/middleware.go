package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

type contextKey string

const principalContextKey contextKey = "principal"

func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := strings.TrimSpace(r.Header.Get("Authorization"))
		if !strings.HasPrefix(authorization, "Bearer ") {
			httpapi.WriteError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}

		clientID := strings.TrimSpace(r.Header.Get(s.clientIDHeader))
		principal, err := s.AuthenticateToken(r.Context(), strings.TrimPrefix(authorization, "Bearer "), clientID)
		if err != nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalContextKey, principal)))
	})
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey).(Principal)
	return principal, ok
}

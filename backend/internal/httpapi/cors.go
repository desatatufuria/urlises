package httpapi

import (
	"net/http"
	"strings"
)

var (
	defaultAllowedHeaders = []string{
		"Accept",
		"Authorization",
		"Content-Type",
		"X-Client-Id",
		"X-Sync-Base-Cursor",
		"X-Sync-Event-Id",
	}
	defaultExposedHeaders = []string{
		"X-Sync-Cursor",
		"X-Sync-Duplicate",
		"X-Sync-Event-Id",
	}
	defaultAllowedMethods = []string{
		http.MethodDelete,
		http.MethodGet,
		http.MethodOptions,
		http.MethodPatch,
		http.MethodPost,
		http.MethodPut,
	}
)

func NewCORS(next http.Handler, allowedOrigins []string) http.Handler {
	allowedOriginSet := make(map[string]struct{}, len(allowedOrigins))
	for _, allowedOrigin := range allowedOrigins {
		trimmed := strings.TrimSpace(allowedOrigin)
		if trimmed == "" {
			continue
		}
		allowedOriginSet[trimmed] = struct{}{}
	}

	allowHeaders := strings.Join(defaultAllowedHeaders, ", ")
	exposeHeaders := strings.Join(defaultExposedHeaders, ", ")
	allowMethods := strings.Join(defaultAllowedMethods, ", ")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Add("Vary", "Origin")
		w.Header().Add("Vary", "Access-Control-Request-Method")
		w.Header().Add("Vary", "Access-Control-Request-Headers")

		if _, ok := allowedOriginSet[origin]; !ok {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", allowMethods)
		w.Header().Set("Access-Control-Allow-Headers", allowHeaders)
		w.Header().Set("Access-Control-Expose-Headers", exposeHeaders)
		w.Header().Set("Access-Control-Max-Age", "600")

		if r.Method == http.MethodOptions && strings.TrimSpace(r.Header.Get("Access-Control-Request-Method")) != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

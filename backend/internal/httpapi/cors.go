package httpapi

import (
	"net/http"
	"strings"
)

var (
	defaultAllowedOrigins = map[string]struct{}{
		"http://localhost:5173": {},
		"http://127.0.0.1:5173": {},
	}
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

func NewDevelopmentCORS(next http.Handler) http.Handler {
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

		if _, ok := defaultAllowedOrigins[origin]; !ok {
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

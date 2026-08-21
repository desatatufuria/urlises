package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
)

// RED: GET /config/public must be unauthenticated and return exactly the
// configured PublicBaseURL as JSON — nothing else from the server config —
// so clients (e.g. the browser extension) can discover the canonical
// share-link base without a full config dump. Mirrors OIDC's
// /.well-known/openid-configuration and Mattermost's /api/v4/config/client.
func TestPublicConfigHandlerReturnsConfiguredBaseURL(t *testing.T) {
	handler := publicConfigHandler(config.AppConfig{PublicBaseURL: "https://admin.urlises.lab.dtfuria.xyz"})

	r := httptest.NewRequest(http.MethodGet, "/config/public", nil)
	w := httptest.NewRecorder()
	handler(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body) != 1 || body["publicBaseUrl"] != "https://admin.urlises.lab.dtfuria.xyz" {
		t.Fatalf("body = %v, want exactly {publicBaseUrl: https://admin.urlises.lab.dtfuria.xyz}", body)
	}
}

// RED: the route must work when registered directly on a mux with no auth
// middleware wrapping it, mirroring /healthz's unauthenticated registration.
func TestConfigPublicRouteIsUnauthenticated(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /config/public", publicConfigHandler(config.AppConfig{PublicBaseURL: "http://localhost:5173"}))

	r := httptest.NewRequest(http.MethodGet, "/config/public", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (no auth required)", w.Code)
	}
}

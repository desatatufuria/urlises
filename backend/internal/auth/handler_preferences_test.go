package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
)

// registerForPreferencesTest creates a user and returns a bearer token/client
// ID pair ready to authenticate against the preferences endpoints.
func registerForPreferencesTest(t *testing.T, mux *http.ServeMux, email, clientID string) string {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/auth/register", bytes.NewBufferString(`{"email":"`+email+`","password":"password"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Client-Id", clientID)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s, want 201", w.Code, w.Body.String())
	}
	var session Session
	if err := json.NewDecoder(w.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	return session.AccessToken
}

// RED: GET /me/preferences round-trips through JSON and defaults to slate
// for a brand new user.
func TestGetPreferencesHandlerRoundTripsJSON(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	token := registerForPreferencesTest(t, mux, "handler-prefs-get@example.test", "handler-prefs-get-client")

	r := httptest.NewRequest(http.MethodGet, "/me/preferences", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Client-Id", "handler-prefs-get-client")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", w.Code, w.Body.String())
	}
	var body Preferences
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.UITheme != "slate" {
		t.Fatalf("uiTheme = %q, want slate", body.UITheme)
	}
}

// RED: PUT /me/preferences persists the new theme and returns it in the
// response body.
func TestUpdatePreferencesHandlerPersistsTheme(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	token := registerForPreferencesTest(t, mux, "handler-prefs-put@example.test", "handler-prefs-put-client")

	r := httptest.NewRequest(http.MethodPut, "/me/preferences", bytes.NewBufferString(`{"uiTheme":"indigo"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Client-Id", "handler-prefs-put-client")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", w.Code, w.Body.String())
	}
	var body Preferences
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.UITheme != "indigo" {
		t.Fatalf("uiTheme = %q, want indigo", body.UITheme)
	}

	r2 := httptest.NewRequest(http.MethodGet, "/me/preferences", nil)
	r2.Header.Set("Authorization", "Bearer "+token)
	r2.Header.Set("X-Client-Id", "handler-prefs-put-client")
	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, r2)
	var reloaded Preferences
	if err := json.NewDecoder(w2.Body).Decode(&reloaded); err != nil {
		t.Fatal(err)
	}
	if reloaded.UITheme != "indigo" {
		t.Fatalf("reloaded uiTheme = %q, want indigo", reloaded.UITheme)
	}
}

// RED: PUT /me/preferences with an unknown theme returns 400 and does not
// change the stored value.
func TestUpdatePreferencesHandlerRejectsInvalidThemeWith400(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	token := registerForPreferencesTest(t, mux, "handler-prefs-bad@example.test", "handler-prefs-bad-client")

	r := httptest.NewRequest(http.MethodPut, "/me/preferences", bytes.NewBufferString(`{"uiTheme":"neon-void"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Client-Id", "handler-prefs-bad-client")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s, want 400", w.Code, w.Body.String())
	}
}

// RED: both preferences routes require authentication.
func TestPreferencesHandlersRequireAuthentication(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	getReq := httptest.NewRequest(http.MethodGet, "/me/preferences", nil)
	getW := httptest.NewRecorder()
	mux.ServeHTTP(getW, getReq)
	if getW.Code != http.StatusUnauthorized {
		t.Fatalf("GET status = %d, want 401", getW.Code)
	}

	putReq := httptest.NewRequest(http.MethodPut, "/me/preferences", bytes.NewBufferString(`{"uiTheme":"teal"}`))
	putReq.Header.Set("Content-Type", "application/json")
	putW := httptest.NewRecorder()
	mux.ServeHTTP(putW, putReq)
	if putW.Code != http.StatusUnauthorized {
		t.Fatalf("PUT status = %d, want 401", putW.Code)
	}
}

package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5"
)

const testRenewableCapabilityHeader = "X-Session-Capability"
const testRenewableCapability = "renewable-v1"

func TestRenewableAuthHandlerPostgres(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"})
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)
	request := func(path, body, clientID, capability string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Client-Id", clientID)
		if capability != "" {
			r.Header.Set(testRenewableCapabilityHeader, capability)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	decode := func(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var value map[string]any
		if err := json.NewDecoder(w.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	setupStatus := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/setup/status", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}

	w := setupStatus()
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || decode(t, w)["required"] != true {
		t.Fatalf("initial setup status = %d %s", w.Code, w.Body.String())
	}

	t.Run("access-only callers retain the exact session shape", func(t *testing.T) {
		w := request("/auth/register", `{"email":"legacy@example.test","password":"password","deviceName":"Legacy"}`, "legacy-client", "")
		if w.Code != http.StatusCreated {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		body := decode(t, w)
		if len(body) != 4 || body["refreshToken"] != nil {
			t.Fatalf("access-only body = %s", w.Body.String())
		}
		w = request("/auth/login", `{"email":"legacy@example.test","password":"password"}`, "legacy-client", "")
		if w.Code != http.StatusOK || len(decode(t, w)) != 4 {
			t.Fatalf("access-only login = %d %s", w.Code, w.Body.String())
		}
		w = setupStatus()
		if w.Code != http.StatusOK || decode(t, w)["required"] != true {
			t.Fatalf("account-only setup status = %d %s", w.Code, w.Body.String())
		}
		if _, err := pool.Exec(ctx, `INSERT INTO organizations(name) VALUES('First Organization')`); err != nil {
			t.Fatal(err)
		}
		w = setupStatus()
		if w.Code != http.StatusOK || decode(t, w)["required"] != false {
			t.Fatalf("organization setup status = %d %s", w.Code, w.Body.String())
		}
	})

	var refresh, email string
	t.Run("renewable registration, login, and response-loss retry", func(t *testing.T) {
		email = "renewable@example.test"
		w := request("/auth/register", `{"email":"`+email+`","password":"password","deviceName":"Renewable"}`, "renewable-client", testRenewableCapability)
		if w.Code != http.StatusCreated {
			t.Fatalf("register status = %d, body = %s", w.Code, w.Body.String())
		}
		registered, _ := decode(t, w)["refreshToken"].(string)
		if registered == "" {
			t.Fatalf("missing refresh token: %s", w.Body.String())
		}
		w = request("/auth/login", `{"email":"`+email+`","password":"password","deviceName":"Renewable"}`, "renewable-client", testRenewableCapability)
		first, _ := decode(t, w)["refreshToken"].(string)
		w = request("/auth/login", `{"email":"`+email+`","password":"password","deviceName":"Renewable"}`, "renewable-client", testRenewableCapability)
		refresh, _ = decode(t, w)["refreshToken"].(string)
		if w.Code != http.StatusOK || first == "" || refresh == "" {
			t.Fatalf("login = %d %s", w.Code, w.Body.String())
		}
		for _, replaced := range []string{registered, first} {
			if w = request("/auth/refresh", `{"refreshToken":"`+replaced+`","attemptId":"replaced"}`, "renewable-client", ""); w.Code != http.StatusUnauthorized {
				t.Fatalf("replaced family status = %d", w.Code)
			}
		}
		w = request("/auth/refresh", `{"refreshToken":"`+refresh+`","attemptId":"attempt-response-loss"}`, "renewable-client", "")
		if w.Code != http.StatusOK {
			t.Fatalf("refresh = %d %s", w.Code, w.Body.String())
		}
		successor, _ := decode(t, w)["refreshToken"].(string)
		w = request("/auth/refresh", `{"refreshToken":"`+refresh+`","attemptId":"attempt-response-loss"}`, "renewable-client", "")
		if w.Code != http.StatusOK || decode(t, w)["refreshToken"] != successor {
			t.Fatalf("retry = %d %s", w.Code, w.Body.String())
		}
		refresh = successor
	})

	t.Run("malformed and invalid refreshes are opaque", func(t *testing.T) {
		if w := request("/auth/refresh", `{}`, "renewable-client", ""); w.Code != http.StatusBadRequest {
			t.Fatalf("malformed status = %d", w.Code)
		}
		w := request("/auth/refresh", `{"refreshToken":"not-a-token","attemptId":"attempt"}`, "renewable-client", "")
		if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "not-a-token") {
			t.Fatalf("invalid = %d %s", w.Code, w.Body.String())
		}
		if w = request("/auth/refresh", `{"refreshToken":"`+refresh+`","attemptId":"attempt"}`, "other-client", ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("client mismatch status = %d", w.Code)
		}
		if w = request("/auth/refresh", `{"refreshToken":"`+refresh+`","attemptId":"attempt"}`, "", ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("missing client status = %d", w.Code)
		}
	})

	t.Run("logout validates client and revokes all device families", func(t *testing.T) {
		if w := request("/auth/logout", `{"refreshToken":"`+refresh+`"}`, "", ""); w.Code != http.StatusBadRequest {
			t.Fatalf("missing client logout = %d %s", w.Code, w.Body.String())
		}
		if w := request("/auth/logout", `{"refreshToken":"invalid"}`, "renewable-client", ""); w.Code != http.StatusNoContent {
			t.Fatalf("invalid logout = %d %s", w.Code, w.Body.String())
		}
		legacy := "deterministic-legacy-sibling"
		var family string
		if err := pool.QueryRow(ctx, `INSERT INTO refresh_families(user_id,device_id) SELECT u.id,d.id FROM users u JOIN devices d ON d.user_id=u.id WHERE u.email=$1 AND d.client_id='renewable-client' RETURNING id`, email).Scan(&family); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO refresh_tokens(family_id,secret_hash) VALUES($1,$2)`, family, service.refresh.(*refreshRepository).hash(legacy)); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if w := request("/auth/logout", `{"refreshToken":"`+refresh+`"}`, "renewable-client", ""); w.Code != http.StatusNoContent {
				t.Fatalf("logout = %d %s", w.Code, w.Body.String())
			}
		}
		for _, revoked := range []string{refresh, legacy} {
			if w := request("/auth/refresh", `{"refreshToken":"`+revoked+`","attemptId":"after-logout"}`, "renewable-client", ""); w.Code != http.StatusUnauthorized {
				t.Fatalf("revoked family status = %d", w.Code)
			}
		}
	})

	t.Run("operational refresh failure is unavailable", func(t *testing.T) {
		previous := service.refresh
		defer func() { service.refresh = previous }()
		service.refresh = unavailableRefresh{}
		w := request("/auth/refresh", `{"refreshToken":"opaque","attemptId":"attempt"}`, "renewable-client", "")
		if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "opaque") {
			t.Fatalf("unavailable = %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("renewable registration and login roll back when family creation fails", func(t *testing.T) {
		w := request("/auth/register", `{"email":"atomic-login@example.test","password":"password"}`, "atomic-login-client", testRenewableCapability)
		prior, _ := decode(t, w)["refreshToken"].(string)
		if _, err := pool.Exec(ctx, `ALTER TABLE refresh_tokens ADD CONSTRAINT fail_renewable_registration CHECK (false) NOT VALID`); err != nil {
			t.Fatal(err)
		}
		w = request("/auth/login", `{"email":"atomic-login@example.test","password":"password"}`, "atomic-login-client", testRenewableCapability)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("login status = %d, body = %s", w.Code, w.Body.String())
		}
		w = request("/auth/register", `{"email":"atomic@example.test","password":"password"}`, "atomic-client", testRenewableCapability)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
		}
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE email='atomic@example.test')`).Scan(&exists); err != nil || exists {
			t.Fatalf("registered after failed family creation = %v, %v", exists, err)
		}
		if _, err := pool.Exec(ctx, `ALTER TABLE refresh_tokens DROP CONSTRAINT fail_renewable_registration`); err != nil {
			t.Fatal(err)
		}
		if w = request("/auth/refresh", `{"refreshToken":"`+prior+`","attemptId":"after-failed-login"}`, "atomic-login-client", ""); w.Code != http.StatusOK {
			t.Fatalf("prior session after failed login = %d %s", w.Code, w.Body.String())
		}
	})
}

// Phase 5 (Slice 5) — RED: POST /me/deactivate is self-only (no body, no
// path/user identifier). 204 on success; the account is then rejected at a
// subsequent login() with 403 ErrAccountDisabled; a sole organization owner
// gets 409 ErrSoleOwner instead; an unauthenticated caller gets 401.
func TestDeactivateSelfHandlerPostgres(t *testing.T) {
	ctx, pool := authTestPool(t, "auth_deactivate_handler_test")
	service := newAuthTestService(pool)
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	bearerRequest := func(method, path, token, clientID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		r.Header.Set("X-Client-Id", clientID)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}

	t.Run("unauthenticated caller is rejected with 401", func(t *testing.T) {
		w := bearerRequest(http.MethodPost, "/me/deactivate", "", "no-client")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("sole owner is rejected with 409 and stays active", func(t *testing.T) {
		session, err := service.RegisterRenewable(ctx, RegisterInput{
			Email:    "deactivate-handler-sole-owner@example.test",
			Password: "password",
		}, "sole-owner-client")
		if err != nil {
			t.Fatalf("register: %v", err)
		}
		organizationID := insertAuthTestOrganization(t, ctx, pool, "Handler Sole Owner Org")
		insertAuthTestMember(t, ctx, pool, organizationID, session.User.ID, "owner")

		w := bearerRequest(http.MethodPost, "/me/deactivate", session.AccessToken, "sole-owner-client")
		if w.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409, body = %s", w.Code, w.Body.String())
		}

		if _, err := service.Login(ctx, LoginInput{Email: "deactivate-handler-sole-owner@example.test", Password: "password"}, "sole-owner-client"); err != nil {
			t.Fatalf("login after blocked deactivation err = %v, want nil (account still active)", err)
		}
	})

	t.Run("self-only success then a subsequent login is 403 ErrAccountDisabled", func(t *testing.T) {
		session, err := service.RegisterRenewable(ctx, RegisterInput{
			Email:    "deactivate-handler-self@example.test",
			Password: "password",
		}, "self-client")
		if err != nil {
			t.Fatalf("register: %v", err)
		}

		w := bearerRequest(http.MethodPost, "/me/deactivate", session.AccessToken, "self-client")
		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204, body = %s", w.Code, w.Body.String())
		}
		if w.Body.Len() != 0 {
			t.Fatalf("body = %q, want empty", w.Body.String())
		}

		_, loginErr := service.Login(ctx, LoginInput{Email: "deactivate-handler-self@example.test", Password: "password"}, "self-client")
		if !errors.Is(loginErr, ErrAccountDisabled) {
			t.Fatalf("login after deactivation err = %v, want %v", loginErr, ErrAccountDisabled)
		}
	})
}

type unavailableRefresh struct{}

func (unavailableRefresh) createTx(context.Context, pgx.Tx, string, string) (RefreshToken, error) {
	return RefreshToken{}, ErrRefreshUnavailable
}
func (unavailableRefresh) rotateForClient(context.Context, string, string, string) (RefreshToken, error) {
	return RefreshToken{}, ErrRefreshUnavailable
}
func (unavailableRefresh) logoutForClient(context.Context, string, string) error {
	return ErrRefreshUnavailable
}
func (unavailableRefresh) revokeAllTx(context.Context, pgx.Tx, string) error {
	return ErrRefreshUnavailable
}

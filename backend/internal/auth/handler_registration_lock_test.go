package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
)

var errRejected = errors.New("invitation is not pending")

// RED: POST /auth/register must forward invitationToken to the service and
// map a locked-registration rejection to 403 Forbidden, without ever
// creating the user.
func TestRegisterHandlerRejectsLockedRegistrationWith403(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organizations(name) VALUES('Existing Org')`); err != nil {
		t.Fatal(err)
	}

	validator := &stubInvitationValidator{err: errRejected}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"},
		WithRegistrationLock(false, validator))
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	r := httptest.NewRequest(http.MethodPost, "/auth/register", bytes.NewBufferString(`{"email":"handler-locked@example.test","password":"password","invitationToken":"whatever"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Client-Id", "handler-locked-client")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s, want 403", w.Code, w.Body.String())
	}
	if validator.calls != 1 || validator.lastToken != "whatever" || validator.lastEmail != "handler-locked@example.test" {
		t.Fatalf("validator called with (%q,%q) x%d, want (whatever,handler-locked@example.test) x1", validator.lastToken, validator.lastEmail, validator.calls)
	}

	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE email='handler-locked@example.test')`).Scan(&exists); err != nil || exists {
		t.Fatalf("user created despite locked registration = %v, %v", exists, err)
	}
}

// RED: when the invitation is valid, the token round-trips through JSON
// decoding all the way into the service call and registration succeeds.
func TestRegisterHandlerForwardsInvitationTokenOnSuccess(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organizations(name) VALUES('Existing Org')`); err != nil {
		t.Fatal(err)
	}

	validator := &stubInvitationValidator{err: nil}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"},
		WithRegistrationLock(false, validator))
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, nil)

	r := httptest.NewRequest(http.MethodPost, "/auth/register", bytes.NewBufferString(`{"email":"handler-invited@example.test","password":"password","invitationToken":"real-token"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Client-Id", "handler-invited-client")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s, want 201", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if validator.calls != 1 || validator.lastToken != "real-token" || validator.lastEmail != "handler-invited@example.test" {
		t.Fatalf("validator called with (%q,%q) x%d, want (real-token,handler-invited@example.test) x1", validator.lastToken, validator.lastEmail, validator.calls)
	}
}

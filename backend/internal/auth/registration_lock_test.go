package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
)

// stubInvitationValidator lets registration-lock tests control whether the
// injected invitation validator accepts or rejects a given token/email pair
// without depending on the organizations package.
type stubInvitationValidator struct {
	err       error
	calls     int
	lastToken string
	lastEmail string
}

func (s *stubInvitationValidator) ValidatePendingInvitation(_ context.Context, token, email string) error {
	s.calls++
	s.lastToken = token
	s.lastEmail = email
	return s.err
}

func TestRegisterBootstrapAlwaysBypassesRegistrationLock(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}

	validator := &stubInvitationValidator{err: errors.New("should never be called during bootstrap")}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"},
		WithRegistrationLock(false, validator))

	_, err := service.Register(ctx, RegisterInput{Email: "first-owner@example.test", Password: "password"}, "bootstrap-client")
	if err != nil {
		t.Fatalf("bootstrap register with lock enabled = %v, want nil", err)
	}
	if validator.calls != 0 {
		t.Fatalf("invitation validator called during bootstrap: %d calls", validator.calls)
	}
}

func TestRegisterOpenLockDisabledAllowsAnyoneAfterBootstrap(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organizations(name) VALUES('Existing Org')`); err != nil {
		t.Fatal(err)
	}

	validator := &stubInvitationValidator{err: errors.New("should never be called when lock is disabled")}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"},
		WithRegistrationLock(true, validator))

	_, err := service.Register(ctx, RegisterInput{Email: "anyone@example.test", Password: "password"}, "open-client")
	if err != nil {
		t.Fatalf("register with lock disabled = %v, want nil", err)
	}
	if validator.calls != 0 {
		t.Fatalf("invitation validator called while lock disabled: %d calls", validator.calls)
	}
}

func TestRegisterLockedRejectsMissingInvitationToken(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organizations(name) VALUES('Existing Org')`); err != nil {
		t.Fatal(err)
	}

	validator := &stubInvitationValidator{err: errors.New("should never be called without a token")}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"},
		WithRegistrationLock(false, validator))

	_, err := service.Register(ctx, RegisterInput{Email: "no-token@example.test", Password: "password"}, "locked-client")
	if !errors.Is(err, ErrRegistrationLocked) {
		t.Fatalf("err = %v, want %v", err, ErrRegistrationLocked)
	}
	if validator.calls != 0 {
		t.Fatalf("invitation validator called without a token: %d calls", validator.calls)
	}
}

func TestRegisterLockedRejectsInvalidInvitation(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organizations(name) VALUES('Existing Org')`); err != nil {
		t.Fatal(err)
	}

	validator := &stubInvitationValidator{err: errors.New("invitation is not pending")}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: 15 * time.Minute, ClientIDHeader: "X-Client-Id"},
		WithRegistrationLock(false, validator))

	_, err := service.Register(ctx, RegisterInput{Email: "invitee@example.test", Password: "password", InvitationToken: "bad-token"}, "locked-client")
	if !errors.Is(err, ErrRegistrationLocked) {
		t.Fatalf("err = %v, want %v", err, ErrRegistrationLocked)
	}
	if validator.calls != 1 || validator.lastToken != "bad-token" || validator.lastEmail != "invitee@example.test" {
		t.Fatalf("validator called with (%q,%q) x%d, want (bad-token,invitee@example.test) x1", validator.lastToken, validator.lastEmail, validator.calls)
	}
}

func TestRegisterLockedAcceptsValidInvitation(t *testing.T) {
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

	session, err := service.Register(ctx, RegisterInput{Email: "Invitee@Example.test", Password: "password", InvitationToken: "good-token"}, "locked-client")
	if err != nil {
		t.Fatalf("register with valid invitation = %v, want nil", err)
	}
	if session.User.Email != "invitee@example.test" {
		t.Fatalf("registered email = %q, want normalized invitee@example.test", session.User.Email)
	}
	if validator.calls != 1 || validator.lastToken != "good-token" || validator.lastEmail != "invitee@example.test" {
		t.Fatalf("validator called with (%q,%q) x%d, want (good-token,invitee@example.test) x1", validator.lastToken, validator.lastEmail, validator.calls)
	}
}

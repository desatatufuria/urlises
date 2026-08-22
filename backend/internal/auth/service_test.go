package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Phase 5 (Slice 5) — RED: a requester who is the sole owner of at least one
// organization must be rejected with ErrSoleOwner, and neither disabled_at
// nor the refresh families may be touched.
func TestDeactivateSelfSoleOwnerBlocked(t *testing.T) {
	t.Parallel()

	ctx, pool := authTestPool(t, "auth_deactivate_test")
	service := newAuthTestService(pool)

	soleOwnerID := insertAuthTestUser(t, ctx, pool, "deactivate-sole-owner@example.test")
	organizationID := insertAuthTestOrganization(t, ctx, pool, "Sole Owner Org")
	insertAuthTestMember(t, ctx, pool, organizationID, soleOwnerID, "owner")

	deviceID := insertAuthTestDevice(t, ctx, pool, soleOwnerID, "sole-owner-client")
	family := insertAuthTestRefreshFamily(t, ctx, pool, soleOwnerID, deviceID)

	err := service.DeactivateSelf(ctx, soleOwnerID)
	if !errors.Is(err, ErrSoleOwner) {
		t.Fatalf("err = %v, want %v", err, ErrSoleOwner)
	}

	var disabledAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT disabled_at FROM users WHERE id = $1`, soleOwnerID).Scan(&disabledAt); err != nil {
		t.Fatalf("load user: %v", err)
	}
	if disabledAt != nil {
		t.Fatalf("disabled_at = %v, want nil (untouched)", disabledAt)
	}

	var revoked bool
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM refresh_families WHERE id = $1`, family).Scan(&revoked); err != nil {
		t.Fatalf("load refresh family: %v", err)
	}
	if revoked {
		t.Fatal("refresh family revoked, want intact")
	}
}

// Phase 5 (Slice 5) — RED: a requester who co-owns an organization is not
// blocked. The happy path sets disabled_at, revokes every refresh family in
// the same commit, and a second call is a no-op guarded by
// "AND disabled_at IS NULL".
func TestDeactivateSelfHappyPathRevokesSessionsAndIsIdempotent(t *testing.T) {
	t.Parallel()

	ctx, pool := authTestPool(t, "auth_deactivate_test")
	service := newAuthTestService(pool)

	coOwnerID := insertAuthTestUser(t, ctx, pool, "deactivate-co-owner@example.test")
	peerOwnerID := insertAuthTestUser(t, ctx, pool, "deactivate-peer-owner@example.test")
	organizationID := insertAuthTestOrganization(t, ctx, pool, "Co-Owned Org")
	insertAuthTestMember(t, ctx, pool, organizationID, coOwnerID, "owner")
	insertAuthTestMember(t, ctx, pool, organizationID, peerOwnerID, "owner")

	deviceID := insertAuthTestDevice(t, ctx, pool, coOwnerID, "co-owner-client")
	family := insertAuthTestRefreshFamily(t, ctx, pool, coOwnerID, deviceID)

	if err := service.DeactivateSelf(ctx, coOwnerID); err != nil {
		t.Fatalf("DeactivateSelf() err = %v, want nil", err)
	}

	var disabledAt *time.Time
	var updatedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT disabled_at, updated_at FROM users WHERE id = $1`, coOwnerID).Scan(&disabledAt, &updatedAt); err != nil {
		t.Fatalf("load user: %v", err)
	}
	if disabledAt == nil {
		t.Fatal("disabled_at = nil, want set")
	}
	firstDisabledAt := *disabledAt

	var revoked bool
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM refresh_families WHERE id = $1`, family).Scan(&revoked); err != nil {
		t.Fatalf("load refresh family: %v", err)
	}
	if !revoked {
		t.Fatal("refresh family revoked = false, want true")
	}

	// Second call is a no-op: no error, disabled_at unchanged.
	if err := service.DeactivateSelf(ctx, coOwnerID); err != nil {
		t.Fatalf("second DeactivateSelf() err = %v, want nil (idempotent no-op)", err)
	}
	var disabledAtAfterSecondCall *time.Time
	if err := pool.QueryRow(ctx, `SELECT disabled_at FROM users WHERE id = $1`, coOwnerID).Scan(&disabledAtAfterSecondCall); err != nil {
		t.Fatalf("load user after second call: %v", err)
	}
	if disabledAtAfterSecondCall == nil || !disabledAtAfterSecondCall.Equal(firstDisabledAt) {
		t.Fatalf("disabled_at after second call = %v, want unchanged %v", disabledAtAfterSecondCall, firstDisabledAt)
	}
}

// Phase 5 (Slice 5) — RED: login() must reject a disabled account with
// ErrAccountDisabled, but ONLY after bcrypt.CompareHashAndPassword succeeds —
// a wrong password on a disabled account must still surface
// ErrInvalidCredentials, never leaking account-disabled state to a caller
// without the password.
func TestLoginRejectsDisabledAccountOnlyAfterPasswordVerifies(t *testing.T) {
	t.Parallel()

	ctx, pool := authTestPool(t, "auth_deactivate_test")
	service := newAuthTestService(pool)

	session, err := service.Register(ctx, RegisterInput{
		Email:    "login-disabled@example.test",
		Password: "correct-password",
	}, "login-disabled-client")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE users SET disabled_at = NOW() WHERE id = $1`, session.User.ID); err != nil {
		t.Fatalf("disable user: %v", err)
	}

	// Wrong password on a disabled account must NOT leak disabled state.
	_, err = service.Login(ctx, LoginInput{
		Email:    "login-disabled@example.test",
		Password: "not-the-password",
	}, "login-disabled-client")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password on disabled account err = %v, want %v", err, ErrInvalidCredentials)
	}

	// Correct password on a disabled account must be rejected as disabled,
	// and must not issue a session.
	_, err = service.Login(ctx, LoginInput{
		Email:    "login-disabled@example.test",
		Password: "correct-password",
	}, "login-disabled-client")
	if !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("correct password on disabled account err = %v, want %v", err, ErrAccountDisabled)
	}
}

// Phase 5 (Slice 5) — RED: AuthenticateToken must reject a token minted
// before deactivation on the very next authenticated request, and Refresh
// must not be able to mint a new session once the refresh family has been
// revoked by DeactivateSelf.
func TestAuthenticateTokenRejectsPreDeactivationTokenAndRefreshCannotRecover(t *testing.T) {
	t.Parallel()

	ctx, pool := authTestPool(t, "auth_deactivate_test")
	service := newAuthTestService(pool)

	renewable, err := service.RegisterRenewable(ctx, RegisterInput{
		Email:    "token-disabled@example.test",
		Password: "password",
	}, "token-disabled-client")
	if err != nil {
		t.Fatalf("register renewable: %v", err)
	}

	// Sanity: the token is valid before deactivation.
	if _, err := service.AuthenticateToken(ctx, renewable.AccessToken, "token-disabled-client"); err != nil {
		t.Fatalf("AuthenticateToken before deactivation err = %v, want nil", err)
	}

	if err := service.DeactivateSelf(ctx, renewable.User.ID); err != nil {
		t.Fatalf("DeactivateSelf() err = %v, want nil", err)
	}

	if _, err := service.AuthenticateToken(ctx, renewable.AccessToken, "token-disabled-client"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("AuthenticateToken after deactivation err = %v, want %v", err, ErrUnauthorized)
	}

	if _, err := service.Refresh(ctx, renewable.RefreshToken, "attempt-after-deactivation", "token-disabled-client"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Refresh after deactivation err = %v, want %v", err, ErrUnauthorized)
	}
}

func newAuthTestService(pool *pgxpool.Pool) *Service {
	return NewService(pool, config.AuthConfig{
		JWTSecret:      []byte("server-secret"),
		TokenTTL:       15 * time.Minute,
		ClientIDHeader: "X-Client-Id",
	})
}

func authTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration-style test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("AUTH_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set AUTH_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
	}

	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	if err := adminPool.Ping(ctx); err != nil {
		adminPool.Close()
		t.Skipf("skipping PostgreSQL test: %v", err)
	}

	schemaName := fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schemaName)); err != nil {
		adminPool.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := adminPool.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schemaName)); err != nil {
			t.Fatalf("drop schema: %v", err)
		}
		adminPool.Close()
	})

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database url: %v", err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open test pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := database.Migrate(ctx, pool, filepath.Clean(filepath.Join("..", "..", "migrations"))); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}

	return ctx, pool
}

func insertAuthTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()

	var userID string
	err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash)
		VALUES ($1, $2)
		RETURNING id
	`, email, "hash").Scan(&userID)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}

	return userID
}

func insertAuthTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
	t.Helper()

	var organizationID string
	err := pool.QueryRow(ctx, `
		INSERT INTO organizations (name)
		VALUES ($1)
		RETURNING id
	`, name).Scan(&organizationID)
	if err != nil {
		t.Fatalf("insert organization: %v", err)
	}

	return organizationID
}

func insertAuthTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func insertAuthTestDevice(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID, clientID string) string {
	t.Helper()

	var deviceID string
	err := pool.QueryRow(ctx, `
		INSERT INTO devices (user_id, client_id)
		VALUES ($1, $2)
		RETURNING id
	`, userID, clientID).Scan(&deviceID)
	if err != nil {
		t.Fatalf("insert device: %v", err)
	}

	return deviceID
}

func insertAuthTestRefreshFamily(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID, deviceID string) string {
	t.Helper()

	var familyID string
	err := pool.QueryRow(ctx, `
		INSERT INTO refresh_families (user_id, device_id)
		VALUES ($1, $2)
		RETURNING id
	`, userID, deviceID).Scan(&familyID)
	if err != nil {
		t.Fatalf("insert refresh family: %v", err)
	}

	return familyID
}

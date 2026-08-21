package secrethide

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// --- Task 1.2: TTL defaults/clamp, generateToken shape, Reveal semantics ---

func TestCreateDefaultTTLAppliedWhenUnspecified(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_ttl_default_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-default-ttl@example.com")

	secret, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	want := secret.CreatedAt.Add(defaultTTL)
	if diff := secret.ExpiresAt.Sub(want); diff < -time.Second || diff > time.Second {
		t.Fatalf("ExpiresAt = %v, want ~%v (CreatedAt + 24h)", secret.ExpiresAt, want)
	}
}

func TestCreateRequestedTTLBeyondCapIsClamped(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_ttl_clamp_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-clamp-ttl@example.com")

	requestedSeconds := int((30 * 24 * time.Hour).Seconds())
	secret, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
		TTLSeconds: &requestedSeconds,
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	want := secret.CreatedAt.Add(maxTTL)
	if diff := secret.ExpiresAt.Sub(want); diff < -time.Second || diff > time.Second {
		t.Fatalf("ExpiresAt = %v, want clamped to CreatedAt + 7d = %v", secret.ExpiresAt, want)
	}
}

func TestGenerateTokenProduces24ByteHexToken(t *testing.T) {
	t.Parallel()

	tokenA, err := generateToken()
	if err != nil {
		t.Fatalf("generateToken: %v", err)
	}
	if len(tokenA) != 48 {
		t.Fatalf("len(token) = %d, want 48 (24 bytes hex-encoded)", len(tokenA))
	}

	decoded, err := hex.DecodeString(tokenA)
	if err != nil {
		t.Fatalf("token %q is not valid hex: %v", tokenA, err)
	}
	if len(decoded) != 24 {
		t.Fatalf("decoded token length = %d bytes, want 24", len(decoded))
	}

	tokenB, err := generateToken()
	if err != nil {
		t.Fatalf("generateToken (second call): %v", err)
	}
	if tokenA == tokenB {
		t.Fatalf("generateToken produced the same token twice: %q", tokenA)
	}
}

func TestRevealReturnsBlobWithoutMutatingStatus(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_reveal_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-reveal@example.com")

	salt := "c2FsdGJ5dGVz"
	iterations := 210000
	wrapped := "d3JhcHBlZGtleQ=="
	created, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext:        "Y2lwaGVydGV4dA==",
		IV:                "aXZieXRlcw==",
		WrappedContentKey: &wrapped,
		PassphraseSalt:    &salt,
		KDFIterations:     &iterations,
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	blob, err := service.Reveal(ctx, created.Token)
	if err != nil {
		t.Fatalf("reveal secret: %v", err)
	}
	if blob.Ciphertext != "Y2lwaGVydGV4dA==" {
		t.Fatalf("blob.Ciphertext = %q, want %q", blob.Ciphertext, "Y2lwaGVydGV4dA==")
	}
	if blob.IV != "aXZieXRlcw==" {
		t.Fatalf("blob.IV = %q, want %q", blob.IV, "aXZieXRlcw==")
	}
	if blob.WrappedContentKey == nil || *blob.WrappedContentKey != wrapped {
		t.Fatalf("blob.WrappedContentKey = %v, want %q", blob.WrappedContentKey, wrapped)
	}
	if blob.PassphraseSalt == nil || *blob.PassphraseSalt != salt {
		t.Fatalf("blob.PassphraseSalt = %v, want %q", blob.PassphraseSalt, salt)
	}
	if blob.KDFIterations == nil || *blob.KDFIterations != iterations {
		t.Fatalf("blob.KDFIterations = %v, want %d", blob.KDFIterations, iterations)
	}

	status := loadSecrethideTestStatus(t, ctx, pool, created.ID)
	if status != "pending" {
		t.Fatalf("status after first reveal = %q, want pending", status)
	}

	if _, err := service.Reveal(ctx, created.Token); err != nil {
		t.Fatalf("second reveal: %v", err)
	}
	status = loadSecrethideTestStatus(t, ctx, pool, created.ID)
	if status != "pending" {
		t.Fatalf("status after second reveal = %q, want pending", status)
	}
}

func TestRevealUnknownTokenReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_reveal_unknown_test")
	service := NewService(pool)

	_, err := service.Reveal(ctx, "does-not-exist")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

func TestRevealExpiredTokenReturnsGone(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_reveal_expired_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-expired@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}
	forceSecrethideTestExpiry(t, ctx, pool, created.ID)

	if _, err := service.Reveal(ctx, created.Token); err != ErrGone {
		t.Fatalf("err = %v, want %v", err, ErrGone)
	}
}

func TestRevealAlreadyReadTokenReturnsGone(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_reveal_already_read_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-already-read@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}
	if _, _, _, err := service.Burn(ctx, created.Token); err != nil {
		t.Fatalf("burn secret: %v", err)
	}

	if _, err := service.Reveal(ctx, created.Token); err != ErrGone {
		t.Fatalf("err = %v, want %v", err, ErrGone)
	}
}

// --- Task 1.3: Burn semantics and idempotency ---

func TestBurnSetsStatusReadAndReturnsCreatorUserID(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_burn_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-burn@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	creatorUserID, secretID, alreadyRead, err := service.Burn(ctx, created.Token)
	if err != nil {
		t.Fatalf("burn secret: %v", err)
	}
	if alreadyRead {
		t.Fatal("alreadyRead = true on first burn, want false")
	}
	if creatorUserID != userID {
		t.Fatalf("creatorUserID = %q, want %q", creatorUserID, userID)
	}
	if secretID != created.ID {
		t.Fatalf("secretID = %q, want %q", secretID, created.ID)
	}

	status, readAt := loadSecrethideTestStatusAndReadAt(t, ctx, pool, created.ID)
	if status != "read" {
		t.Fatalf("status = %q, want read", status)
	}
	if readAt == nil {
		t.Fatal("read_at is nil after burn, want non-nil")
	}
}

func TestBurnIsIdempotentOnRepeat(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_burn_idempotent_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-burn-idempotent@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	if _, _, alreadyRead, err := service.Burn(ctx, created.Token); err != nil || alreadyRead {
		t.Fatalf("first burn: alreadyRead=%v err=%v, want false/nil", alreadyRead, err)
	}
	_, firstReadAt := loadSecrethideTestStatusAndReadAt(t, ctx, pool, created.ID)
	if firstReadAt == nil {
		t.Fatal("read_at is nil after first burn")
	}

	creatorUserID, secretID, alreadyRead, err := service.Burn(ctx, created.Token)
	if err != nil {
		t.Fatalf("second burn: %v", err)
	}
	if !alreadyRead {
		t.Fatal("alreadyRead = false on second burn, want true")
	}
	if creatorUserID != userID {
		t.Fatalf("creatorUserID on second burn = %q, want %q", creatorUserID, userID)
	}
	if secretID != created.ID {
		t.Fatalf("secretID on second burn = %q, want %q", secretID, created.ID)
	}

	status, secondReadAt := loadSecrethideTestStatusAndReadAt(t, ctx, pool, created.ID)
	if status != "read" {
		t.Fatalf("status after second burn = %q, want read", status)
	}
	if secondReadAt == nil || !secondReadAt.Equal(*firstReadAt) {
		t.Fatalf("read_at changed on repeated burn: first=%v second=%v", firstReadAt, secondReadAt)
	}
}

// --- Task: LoadOwned collapses unknown token, wrong owner, and non-pending
// status into the same ErrNotFound, so the send-email endpoint built on top
// of it can never be used to enumerate other users' tokens or a secret's
// current state. ---

func TestLoadOwnedReturnsSecretForOwnerAndPendingStatus(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_load_owned_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-load-owned@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	secret, err := service.LoadOwned(ctx, created.Token, userID)
	if err != nil {
		t.Fatalf("LoadOwned: %v", err)
	}
	if secret.ID != created.ID {
		t.Fatalf("secret.ID = %q, want %q", secret.ID, created.ID)
	}
	if secret.Status != "pending" {
		t.Fatalf("secret.Status = %q, want pending", secret.Status)
	}
}

func TestLoadOwnedUnknownTokenReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_load_owned_unknown_test")
	service := NewService(pool)

	if _, err := service.LoadOwned(ctx, "does-not-exist", "irrelevant-user"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

func TestLoadOwnedWrongOwnerReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_load_owned_wrong_owner_test")
	service := NewService(pool)
	ownerID := insertSecrethideTestUser(t, ctx, pool, "owner-load-owned@example.com")
	otherID := insertSecrethideTestUser(t, ctx, pool, "other-load-owned@example.com")

	created, err := service.Create(ctx, ownerID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	if _, err := service.LoadOwned(ctx, created.Token, otherID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want %v (a non-owner must get the same not-found error as an unknown token)", err, ErrNotFound)
	}
}

func TestLoadOwnedNonPendingStatusReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_load_owned_wrong_status_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-load-owned-status@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}
	if _, _, _, err := service.Burn(ctx, created.Token); err != nil {
		t.Fatalf("burn secret: %v", err)
	}

	if _, err := service.LoadOwned(ctx, created.Token, userID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want %v (a burned secret must get the same not-found error as an unknown token)", err, ErrNotFound)
	}
}

// --- Task: ListOwned powers the micro-registry — a caller's own secrets,
// newest first, with status computed (pending/read/expired), capped at 50,
// and never leaking another user's secrets. ---

func TestListOwnedReturnsEmptyListWhenCallerHasNoSecrets(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_list_owned_empty_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-list-empty@example.com")

	secrets, err := service.ListOwned(ctx, userID)
	if err != nil {
		t.Fatalf("ListOwned: %v", err)
	}
	if len(secrets) != 0 {
		t.Fatalf("len(secrets) = %d, want 0", len(secrets))
	}
}

func TestListOwnedReturnsOnlyCallersOwnSecretsOrderedNewestFirst(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_list_owned_order_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-list-order@example.com")
	otherID := insertSecrethideTestUser(t, ctx, pool, "other-list-order@example.com")

	first, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create first secret: %v", err)
	}
	second, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create second secret: %v", err)
	}
	if _, err := service.Create(ctx, otherID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="}); err != nil {
		t.Fatalf("create other user's secret: %v", err)
	}

	secrets, err := service.ListOwned(ctx, userID)
	if err != nil {
		t.Fatalf("ListOwned: %v", err)
	}
	if len(secrets) != 2 {
		t.Fatalf("len(secrets) = %d, want 2 (must not include other user's secret)", len(secrets))
	}
	if secrets[0].ID != second.ID || secrets[1].ID != first.ID {
		t.Fatalf("secrets = [%s, %s], want [%s, %s] (newest first)", secrets[0].ID, secrets[1].ID, second.ID, first.ID)
	}
	for _, secret := range secrets {
		if secret.UserID != userID {
			t.Fatalf("secret.UserID = %q, want only %q", secret.UserID, userID)
		}
	}
}

func TestListOwnedIncludesPendingReadAndExpiredSecrets(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_list_owned_mix_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-list-mix@example.com")

	pending, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create pending secret: %v", err)
	}

	readSecret, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret to burn: %v", err)
	}
	if _, _, _, err := service.Burn(ctx, readSecret.Token); err != nil {
		t.Fatalf("burn secret: %v", err)
	}

	expiredUnread, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret to expire: %v", err)
	}
	forceSecrethideTestExpiry(t, ctx, pool, expiredUnread.ID)

	secrets, err := service.ListOwned(ctx, userID)
	if err != nil {
		t.Fatalf("ListOwned: %v", err)
	}
	if len(secrets) != 3 {
		t.Fatalf("len(secrets) = %d, want 3", len(secrets))
	}

	byID := make(map[string]Secret, len(secrets))
	for _, secret := range secrets {
		byID[secret.ID] = secret
	}

	if got := byID[pending.ID]; got.Status != "pending" {
		t.Fatalf("pending secret status = %q, want pending", got.Status)
	}
	if got := byID[readSecret.ID]; got.Status != "read" || got.ReadAt == nil {
		t.Fatalf("read secret status = %q, ReadAt = %v, want read with non-nil ReadAt", got.Status, got.ReadAt)
	}
	// The "expired" state is computed by the caller (handler view), not
	// stored: the DB row still has status "pending" with a past ExpiresAt —
	// ListOwned returns the raw row so the caller can compute expiry.
	if got := byID[expiredUnread.ID]; got.Status != "pending" || !time.Now().UTC().After(got.ExpiresAt) {
		t.Fatalf("expired-unread secret status = %q, ExpiresAt = %v, want raw pending row with a past ExpiresAt", got.Status, got.ExpiresAt)
	}
}

func TestListOwnedCapsAtFiftyResults(t *testing.T) {
	t.Parallel()

	ctx, pool := openSecrethideTestPool(t, "secrethide_list_owned_cap_test")
	service := NewService(pool)
	userID := insertSecrethideTestUser(t, ctx, pool, "creator-list-cap@example.com")

	for i := 0; i < 55; i++ {
		if _, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="}); err != nil {
			t.Fatalf("create secret %d: %v", i, err)
		}
	}

	secrets, err := service.ListOwned(ctx, userID)
	if err != nil {
		t.Fatalf("ListOwned: %v", err)
	}
	if len(secrets) != 50 {
		t.Fatalf("len(secrets) = %d, want 50 (hard cap)", len(secrets))
	}
}

// --- Test helpers (mirrors organizations' openOrganizationsTestPool pattern) ---

func openSecrethideTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration-style test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("SECRETHIDE_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set SECRETHIDE_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

func insertSecrethideTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func loadSecrethideTestStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secretID string) string {
	t.Helper()

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM secrets WHERE id = $1`, secretID).Scan(&status); err != nil {
		t.Fatalf("load secret status: %v", err)
	}
	return status
}

func loadSecrethideTestStatusAndReadAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secretID string) (string, *time.Time) {
	t.Helper()

	var (
		status string
		readAt *time.Time
	)
	if err := pool.QueryRow(ctx, `SELECT status, read_at FROM secrets WHERE id = $1`, secretID).Scan(&status, &readAt); err != nil {
		t.Fatalf("load secret status/read_at: %v", err)
	}
	return status, readAt
}

func forceSecrethideTestExpiry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secretID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE secrets SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, secretID); err != nil {
		t.Fatalf("force secret expiry: %v", err)
	}
}

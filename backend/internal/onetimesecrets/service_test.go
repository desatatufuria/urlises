package onetimesecrets

import (
	"context"
	"encoding/hex"
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

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_ttl_default_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-default-ttl@example.com")

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

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_ttl_clamp_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-clamp-ttl@example.com")

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

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_reveal_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-reveal@example.com")

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

	status := loadOnetimesecretsTestStatus(t, ctx, pool, created.ID)
	if status != "pending" {
		t.Fatalf("status after first reveal = %q, want pending", status)
	}

	if _, err := service.Reveal(ctx, created.Token); err != nil {
		t.Fatalf("second reveal: %v", err)
	}
	status = loadOnetimesecretsTestStatus(t, ctx, pool, created.ID)
	if status != "pending" {
		t.Fatalf("status after second reveal = %q, want pending", status)
	}
}

func TestRevealUnknownTokenReturnsNotFound(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_reveal_unknown_test")
	service := NewService(pool)

	_, err := service.Reveal(ctx, "does-not-exist")
	if err != ErrNotFound {
		t.Fatalf("err = %v, want %v", err, ErrNotFound)
	}
}

func TestRevealExpiredTokenReturnsGone(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_reveal_expired_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-expired@example.com")

	created, err := service.Create(ctx, userID, CreateSecretInput{
		Ciphertext: "Y2lwaGVydGV4dA==",
		IV:         "aXZieXRlcw==",
	})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}
	forceOnetimesecretsTestExpiry(t, ctx, pool, created.ID)

	if _, err := service.Reveal(ctx, created.Token); err != ErrGone {
		t.Fatalf("err = %v, want %v", err, ErrGone)
	}
}

func TestRevealAlreadyReadTokenReturnsGone(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_reveal_already_read_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-already-read@example.com")

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

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_burn_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-burn@example.com")

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

	status, readAt := loadOnetimesecretsTestStatusAndReadAt(t, ctx, pool, created.ID)
	if status != "read" {
		t.Fatalf("status = %q, want read", status)
	}
	if readAt == nil {
		t.Fatal("read_at is nil after burn, want non-nil")
	}
}

func TestBurnIsIdempotentOnRepeat(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_burn_idempotent_test")
	service := NewService(pool)
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-burn-idempotent@example.com")

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
	_, firstReadAt := loadOnetimesecretsTestStatusAndReadAt(t, ctx, pool, created.ID)
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

	status, secondReadAt := loadOnetimesecretsTestStatusAndReadAt(t, ctx, pool, created.ID)
	if status != "read" {
		t.Fatalf("status after second burn = %q, want read", status)
	}
	if secondReadAt == nil || !secondReadAt.Equal(*firstReadAt) {
		t.Fatalf("read_at changed on repeated burn: first=%v second=%v", firstReadAt, secondReadAt)
	}
}

// --- Test helpers (mirrors organizations' openOrganizationsTestPool pattern) ---

func openOnetimesecretsTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration-style test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("ONETIMESECRETS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set ONETIMESECRETS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

func insertOnetimesecretsTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func loadOnetimesecretsTestStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secretID string) string {
	t.Helper()

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM secrets WHERE id = $1`, secretID).Scan(&status); err != nil {
		t.Fatalf("load secret status: %v", err)
	}
	return status
}

func loadOnetimesecretsTestStatusAndReadAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secretID string) (string, *time.Time) {
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

func forceOnetimesecretsTestExpiry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, secretID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE secrets SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, secretID); err != nil {
		t.Fatalf("force secret expiry: %v", err)
	}
}

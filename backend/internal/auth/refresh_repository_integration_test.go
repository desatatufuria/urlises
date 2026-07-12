package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRefreshFamiliesPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping PostgreSQL refresh-family test in short mode")
	}
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	var migrated bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE filename='000006_refresh_sessions.sql')`).Scan(&migrated); err != nil || !migrated {
		t.Fatalf("migration recorded = %v, %v", migrated, err)
	}
	var user, device string
	if err := pool.QueryRow(ctx, `INSERT INTO users(email,password_hash) VALUES('refresh@example.test','x') RETURNING id`).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO devices(user_id,client_id) VALUES($1,'client-a') RETURNING id`, user).Scan(&device); err != nil {
		t.Fatal(err)
	}
	repo := newRefreshRepository(pool, []byte("server-secret"))
	initial, err := repo.Create(ctx, user, "client-a")
	if err != nil {
		t.Fatal(err)
	}
	if initial.Token == "" {
		t.Fatal("missing initial token")
	}
	var stored []byte
	if err := pool.QueryRow(ctx, `SELECT secret_hash FROM refresh_tokens`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if string(stored) == initial.Token || strings.Contains(string(stored), initial.Token) {
		t.Fatal("plaintext token persisted")
	}
	if len(stored) != 32 {
		t.Fatalf("hash length = %d", len(stored))
	}
	for _, tc := range []struct{ name, token string }{{"empty", ""}, {"unknown", "not-a-refresh-token"}} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := repo.Rotate(ctx, tc.token, "attempt-invalid"); !errors.Is(err, ErrUnauthorized) || (tc.token != "" && strings.Contains(err.Error(), tc.token)) {
				t.Fatalf("error = %v", err)
			}
		})
	}

	rotated, err := repo.Rotate(ctx, initial.Token, "attempt-1")
	if err != nil {
		t.Fatal(err)
	}
	retried, err := repo.Rotate(ctx, initial.Token, "attempt-1")
	if err != nil || rotated.Token != retried.Token {
		t.Fatalf("retry = %#v, %v", retried, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE refresh_tokens SET retry_until=NOW()-INTERVAL '1 second' WHERE retry_attempt_id='attempt-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Rotate(ctx, initial.Token, "attempt-1"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("late retry error = %v", err)
	}
	var lateRevoked bool
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM refresh_families WHERE id=$1`, initial.FamilyID).Scan(&lateRevoked); err != nil || !lateRevoked {
		t.Fatalf("late family revoked = %v, %v", lateRevoked, err)
	}

	initial, err = repo.Create(ctx, user, "client-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Rotate(ctx, initial.Token, "attempt-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Rotate(ctx, initial.Token, "attempt-2"); !errors.Is(err, ErrUnauthorized) || strings.Contains(err.Error(), initial.Token) {
		t.Fatalf("reuse error = %v", err)
	}
	var revoked bool
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM refresh_families WHERE id=$1`, initial.FamilyID).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("family revoked = %v, %v", revoked, err)
	}

	second, err := repo.Create(ctx, user, "client-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Logout(ctx, second.Token); err != nil {
		t.Fatal(err)
	}
	third, err := repo.Create(ctx, user, "client-a")
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret")})
	tx, err := pool.Begin(ctx)
	requireNoError(t, err)
	requireNoError(t, service.RevokeAllRefreshFamiliesTx(ctx, tx, user))
	requireNoError(t, tx.Rollback(ctx))
	if _, err := repo.Rotate(ctx, third.Token, "attempt-3"); err != nil {
		t.Fatalf("rotation after caller rollback = %v", err)
	}
	fourth, err := repo.Create(ctx, user, "client-a")
	requireNoError(t, err)
	tx, err = pool.Begin(ctx)
	requireNoError(t, err)
	requireNoError(t, service.RevokeAllRefreshFamiliesTx(ctx, tx, user))
	requireNoError(t, tx.Commit(ctx))
	if _, err := repo.Rotate(ctx, fourth.Token, "attempt-4"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("rotation after caller commit = %v", err)
	}
	standalone, err := repo.Create(ctx, user, "client-a")
	requireNoError(t, err)
	requireNoError(t, service.RevokeAllRefreshFamilies(ctx, user))
	if _, err := repo.Rotate(ctx, standalone.Token, "attempt-standalone"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("standalone revoke-all error = %v", err)
	}

	failing, err := repo.Create(ctx, user, "client-a")
	requireNoError(t, err)
	_, err = repo.Rotate(ctx, failing.Token, "attempt-fail-1")
	requireNoError(t, err)
	_, err = pool.Exec(ctx, `ALTER TABLE refresh_families ADD CONSTRAINT force_reuse_failure CHECK (reuse_detected_at IS NULL) NOT VALID`)
	requireNoError(t, err)
	if _, err := repo.Rotate(ctx, failing.Token, "attempt-fail-2"); !errors.Is(err, ErrRefreshUnavailable) || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("reuse write failure = %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM refresh_families WHERE id=$1`, failing.FamilyID).Scan(&revoked); err != nil || revoked {
		t.Fatalf("failed reuse revocation persisted = %v, %v", revoked, err)
	}
	_ = device
}

func requireNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func refreshTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("refresh_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

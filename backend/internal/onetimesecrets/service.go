// Package onetimesecrets implements zero-knowledge, one-time-read secret
// sharing: the server stores and serves only ciphertext, an optional wrapped
// content key, and metadata — it never sees plaintext.
package onetimesecrets

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrNotFound is returned when no secret exists for a given token.
	ErrNotFound = errors.New("not found")
	// ErrGone is returned for a token that exists but is no longer
	// readable (expired or already burned) — distinguishable from
	// ErrNotFound so callers can map to 404 vs 410 respectively.
	ErrGone = errors.New("gone")
)

const (
	// defaultTTL is the expiry applied when a caller does not request one.
	defaultTTL = 24 * time.Hour
	// maxTTL is a hard cap applied regardless of any client-requested TTL.
	maxTTL = 7 * 24 * time.Hour
)

// Service wraps the connection pool used to create, reveal, and burn
// one-time secrets. It mirrors organizations.Service's shape.
type Service struct {
	pool *pgxpool.Pool
}

// NewService constructs a Service backed by pool.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// CreateSecretInput is the caller-supplied payload for creating a secret.
// The server never receives plaintext, an unwrapped content key, or a
// passphrase — only already-encrypted material and, when
// passphrase-protected, the wrapped key and its KDF parameters.
type CreateSecretInput struct {
	Ciphertext        string  `json:"ciphertext"`
	IV                string  `json:"iv"`
	WrappedContentKey *string `json:"wrappedContentKey,omitempty"`
	PassphraseSalt    *string `json:"passphraseSalt,omitempty"`
	KDFIterations     *int    `json:"kdfIterations,omitempty"`
	TTLSeconds        *int    `json:"ttlSeconds,omitempty"`
}

// Secret is the persisted row, without the ciphertext blob (see SecretBlob
// for the reveal payload).
type Secret struct {
	ID        string
	UserID    string
	Token     string
	Status    string
	CreatedAt time.Time
	ExpiresAt time.Time
	ReadAt    *time.Time
}

// SecretBlob is the ciphertext payload returned by Reveal.
type SecretBlob struct {
	Ciphertext        string
	IV                string
	WrappedContentKey *string
	PassphraseSalt    *string
	KDFIterations     *int
}

// Create persists a new secret for userID. TTLSeconds, when supplied, is
// clamped to maxTTL; when omitted (or non-positive), defaultTTL applies.
func (s *Service) Create(ctx context.Context, userID string, input CreateSecretInput) (Secret, error) {
	token, err := generateToken()
	if err != nil {
		return Secret{}, err
	}

	expiresAt := time.Now().UTC().Add(resolveTTL(input.TTLSeconds))

	var secret Secret
	err = s.pool.QueryRow(ctx, `
		INSERT INTO secrets (user_id, token, ciphertext, iv, wrapped_content_key, passphrase_salt, kdf_iterations, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, user_id, token, status, created_at, expires_at, read_at
	`,
		userID,
		token,
		[]byte(input.Ciphertext),
		[]byte(input.IV),
		nullableBytes(input.WrappedContentKey),
		nullableBytes(input.PassphraseSalt),
		input.KDFIterations,
		expiresAt,
	).Scan(
		&secret.ID,
		&secret.UserID,
		&secret.Token,
		&secret.Status,
		&secret.CreatedAt,
		&secret.ExpiresAt,
		&secret.ReadAt,
	)
	if err != nil {
		return Secret{}, fmt.Errorf("create secret: %w", err)
	}

	return secret, nil
}

// Reveal returns the ciphertext blob for token without mutating status —
// it is idempotent and repeatable until the secret is burned or expires.
func (s *Service) Reveal(ctx context.Context, token string) (SecretBlob, error) {
	var (
		blob                              SecretBlob
		status                            string
		expiresAt                         time.Time
		ciphertext, iv                    []byte
		wrappedContentKey, passphraseSalt []byte
	)

	err := s.pool.QueryRow(ctx, `
		SELECT ciphertext, iv, wrapped_content_key, passphrase_salt, kdf_iterations, status, expires_at
		FROM secrets
		WHERE token = $1
	`, token).Scan(
		&ciphertext,
		&iv,
		&wrappedContentKey,
		&passphraseSalt,
		&blob.KDFIterations,
		&status,
		&expiresAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SecretBlob{}, ErrNotFound
		}
		return SecretBlob{}, fmt.Errorf("load secret: %w", err)
	}

	if status != "pending" || time.Now().UTC().After(expiresAt) {
		return SecretBlob{}, ErrGone
	}

	blob.Ciphertext = string(ciphertext)
	blob.IV = string(iv)
	blob.WrappedContentKey = bytesToNullableString(wrappedContentKey)
	blob.PassphraseSalt = bytesToNullableString(passphraseSalt)

	return blob, nil
}

// Burn marks token's secret as read and returns the creator's user ID.
// Repeated calls after the first success are a no-op: alreadyRead is true
// and the original read_at is left untouched (so a caller never
// double-notifies the creator).
func (s *Service) Burn(ctx context.Context, token string) (creatorUserID string, alreadyRead bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", false, fmt.Errorf("begin burn tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var (
		id        string
		userID    string
		status    string
		expiresAt time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT id, user_id, status, expires_at
		FROM secrets
		WHERE token = $1
		FOR UPDATE
	`, token).Scan(&id, &userID, &status, &expiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, ErrNotFound
		}
		return "", false, fmt.Errorf("load secret for burn: %w", err)
	}

	if status == "read" {
		if err := tx.Commit(ctx); err != nil {
			return "", false, fmt.Errorf("commit burn tx: %w", err)
		}
		return userID, true, nil
	}

	if time.Now().UTC().After(expiresAt) {
		return "", false, ErrGone
	}

	if _, err := tx.Exec(ctx, `
		UPDATE secrets
		SET status = 'read', read_at = NOW()
		WHERE id = $1
	`, id); err != nil {
		return "", false, fmt.Errorf("burn secret: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("commit burn tx: %w", err)
	}

	return userID, false, nil
}

// resolveTTL applies the default/clamp rules: nil or non-positive
// requestedSeconds falls back to defaultTTL; anything beyond maxTTL is
// clamped down to it.
func resolveTTL(requestedSeconds *int) time.Duration {
	if requestedSeconds == nil || *requestedSeconds <= 0 {
		return defaultTTL
	}

	requested := time.Duration(*requestedSeconds) * time.Second
	if requested > maxTTL {
		return maxTTL
	}

	return requested
}

// generateToken mirrors organizations.generateInviteToken: 24 random bytes,
// hex-encoded into a 48-character token.
func generateToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate secret token: %w", err)
	}

	return hex.EncodeToString(buffer), nil
}

func nullableBytes(v *string) []byte {
	if v == nil {
		return nil
	}
	return []byte(*v)
}

func bytesToNullableString(v []byte) *string {
	if v == nil {
		return nil
	}
	s := string(v)
	return &s
}

package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const refreshRetryWindow = time.Minute

type RefreshToken struct{ Token, FamilyID string }
type refreshRepository struct {
	pool *pgxpool.Pool
	key  []byte
}

func newRefreshRepository(pool *pgxpool.Pool, key []byte) *refreshRepository {
	return &refreshRepository{pool: pool, key: key}
}

func (r *refreshRepository) Create(ctx context.Context, userID, clientID string) (RefreshToken, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	defer tx.Rollback(ctx)
	var family string
	err = tx.QueryRow(ctx, `INSERT INTO refresh_families(user_id,device_id)
		SELECT $1,id FROM devices WHERE user_id=$1 AND client_id=$2 RETURNING id`, userID, clientID).Scan(&family)
	if err != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	token := r.derive("initial", family)
	if _, err = tx.Exec(ctx, `INSERT INTO refresh_tokens(family_id,secret_hash) VALUES($1,$2)`, family, r.hash(token)); err != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	if err = tx.Commit(ctx); err != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	return RefreshToken{Token: token, FamilyID: family}, nil
}

func (r *refreshRepository) Rotate(ctx context.Context, token, attempt string) (RefreshToken, error) {
	if strings.TrimSpace(token) == "" || strings.TrimSpace(attempt) == "" {
		return RefreshToken{}, ErrUnauthorized
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	defer tx.Rollback(ctx)
	var family, retiredAttempt string
	var retired, revoked bool
	var retryUntil *time.Time
	err = tx.QueryRow(ctx, `SELECT f.id,t.retired_at IS NOT NULL,f.revoked_at IS NOT NULL,COALESCE(t.retry_attempt_id,''),t.retry_until
		FROM refresh_tokens t JOIN refresh_families f ON f.id=t.family_id WHERE t.secret_hash=$1 FOR UPDATE OF t,f`, r.hash(token)).Scan(&family, &retired, &revoked, &retiredAttempt, &retryUntil)
	if err != nil || revoked {
		return RefreshToken{}, ErrUnauthorized
	}
	if retired {
		if retiredAttempt == attempt && retryUntil != nil && time.Now().Before(*retryUntil) {
			return RefreshToken{Token: r.derive("child", token, attempt), FamilyID: family}, tx.Commit(ctx)
		}
		command, err := tx.Exec(ctx, `UPDATE refresh_families SET revoked_at=COALESCE(revoked_at,NOW()),reuse_detected_at=NOW() WHERE id=$1`, family)
		if err != nil || command.RowsAffected() != 1 {
			return RefreshToken{}, ErrRefreshUnavailable
		}
		if err := tx.Commit(ctx); err != nil {
			return RefreshToken{}, ErrRefreshUnavailable
		}
		return RefreshToken{}, ErrUnauthorized
	}
	child := r.derive("child", token, attempt)
	var childID string
	if err = tx.QueryRow(ctx, `INSERT INTO refresh_tokens(family_id,secret_hash) VALUES($1,$2) RETURNING id`, family, r.hash(child)).Scan(&childID); err != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	nextRetry := time.Now().Add(refreshRetryWindow)
	_, err = tx.Exec(ctx, `UPDATE refresh_tokens SET retired_at=NOW(),retry_attempt_id=$2,retry_until=$3,rotated_to_id=$4 WHERE secret_hash=$1`, r.hash(token), attempt, nextRetry, childID)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE refresh_families SET rotation_count=rotation_count+1 WHERE id=$1`, family)
	}
	if err != nil || tx.Commit(ctx) != nil {
		return RefreshToken{}, ErrUnauthorized
	}
	return RefreshToken{Token: child, FamilyID: family}, nil
}

func (r *refreshRepository) Logout(ctx context.Context, token string) error {
	command, err := r.pool.Exec(ctx, `UPDATE refresh_families f SET revoked_at=COALESCE(revoked_at,NOW()) FROM refresh_tokens t WHERE t.family_id=f.id AND t.secret_hash=$1`, r.hash(token))
	if err != nil || command.RowsAffected() != 1 {
		return ErrUnauthorized
	}
	return nil
}
func (r *refreshRepository) revokeAllTx(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `UPDATE refresh_families SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1`, userID)
	return err
}
func (r *refreshRepository) derive(parts ...string) string {
	m := hmac.New(sha256.New, r.key)
	for _, p := range parts {
		_, _ = m.Write([]byte{0})
		_, _ = m.Write([]byte(p))
	}
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func (r *refreshRepository) hash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

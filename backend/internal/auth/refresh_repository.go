package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const refreshRetryWindow = time.Minute

type RefreshToken struct{ Token, FamilyID, UserID string }
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
		return RefreshToken{}, ErrRefreshUnavailable
	}
	defer tx.Rollback(ctx)
	token, err := r.createTx(ctx, tx, userID, clientID)
	if err != nil {
		return RefreshToken{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	return token, nil
}

func (r *refreshRepository) createTx(ctx context.Context, tx pgx.Tx, userID, clientID string) (RefreshToken, error) {
	var deviceID string
	err := tx.QueryRow(ctx, `SELECT id FROM devices WHERE user_id=$1 AND client_id=$2 FOR UPDATE`, userID, clientID).Scan(&deviceID)
	if err != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	if _, err = tx.Exec(ctx, `UPDATE refresh_families SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL`, userID, deviceID); err != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	var family string
	err = tx.QueryRow(ctx, `INSERT INTO refresh_families(user_id,device_id) VALUES($1,$2) RETURNING id`, userID, deviceID).Scan(&family)
	if err != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	token := r.derive("initial", family)
	if _, err := tx.Exec(ctx, `INSERT INTO refresh_tokens(family_id,secret_hash) VALUES($1,$2)`, family, r.hash(token)); err != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	return RefreshToken{Token: token, FamilyID: family, UserID: userID}, nil
}

func (r *refreshRepository) Rotate(ctx context.Context, token, attempt string) (RefreshToken, error) {
	return r.rotateForClient(ctx, token, attempt, "")
}

func (r *refreshRepository) rotateForClient(ctx context.Context, token, attempt, clientID string) (RefreshToken, error) {
	if strings.TrimSpace(token) == "" || strings.TrimSpace(attempt) == "" {
		return RefreshToken{}, ErrUnauthorized
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	defer tx.Rollback(ctx)
	var family, userID, retiredAttempt string
	var retired, revoked bool
	var retryUntil *time.Time
	err = tx.QueryRow(ctx, `SELECT f.id,f.user_id,t.retired_at IS NOT NULL,f.revoked_at IS NOT NULL,COALESCE(t.retry_attempt_id,''),t.retry_until
		FROM refresh_tokens t JOIN refresh_families f ON f.id=t.family_id JOIN devices d ON d.id=f.device_id
		WHERE t.secret_hash=$1 AND ($2='' OR d.client_id=$2) FOR UPDATE OF t,f`, r.hash(token), clientID).Scan(&family, &userID, &retired, &revoked, &retiredAttempt, &retryUntil)
	if err != nil || revoked {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return RefreshToken{}, ErrRefreshUnavailable
		}
		return RefreshToken{}, ErrUnauthorized
	}
	if retired {
		if retiredAttempt == attempt && retryUntil != nil && time.Now().Before(*retryUntil) {
			if err := tx.Commit(ctx); err != nil {
				return RefreshToken{}, ErrRefreshUnavailable
			}
			return RefreshToken{Token: r.derive("child", token, attempt), FamilyID: family, UserID: userID}, nil
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
		return RefreshToken{}, ErrRefreshUnavailable
	}
	nextRetry := time.Now().Add(refreshRetryWindow)
	_, err = tx.Exec(ctx, `UPDATE refresh_tokens SET retired_at=NOW(),retry_attempt_id=$2,retry_until=$3,rotated_to_id=$4 WHERE secret_hash=$1`, r.hash(token), attempt, nextRetry, childID)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE refresh_families SET rotation_count=rotation_count+1 WHERE id=$1`, family)
	}
	if err != nil || tx.Commit(ctx) != nil {
		return RefreshToken{}, ErrRefreshUnavailable
	}
	return RefreshToken{Token: child, FamilyID: family, UserID: userID}, nil
}

func (r *refreshRepository) Logout(ctx context.Context, token string) error {
	return r.logoutForClient(ctx, token, "")
}

func (r *refreshRepository) logoutForClient(ctx context.Context, token, clientID string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return ErrRefreshUnavailable
	}
	defer tx.Rollback(ctx)
	var userID, deviceID string
	err = tx.QueryRow(ctx, `SELECT f.user_id,f.device_id FROM refresh_tokens t JOIN refresh_families f ON f.id=t.family_id JOIN devices d ON d.id=f.device_id WHERE t.secret_hash=$1 AND ($2='' OR d.client_id=$2) AND f.revoked_at IS NULL FOR UPDATE OF d`, r.hash(token), clientID).Scan(&userID, &deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return ErrRefreshUnavailable
	}
	if _, err = tx.Exec(ctx, `UPDATE refresh_families SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND device_id=$2`, userID, deviceID); err != nil {
		return ErrRefreshUnavailable
	}
	if err = tx.Commit(ctx); err != nil {
		return ErrRefreshUnavailable
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

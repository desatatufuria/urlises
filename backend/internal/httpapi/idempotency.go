package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrIdempotencyKeyConflict = errors.New("idempotency_key_conflict")
	ErrIdempotencyInProgress  = errors.New("idempotency_in_progress")
)

type IdempotencyIdentity struct {
	PrincipalID string
	Method      string
	Route       string
	Key         string
	Fingerprint string
}

type SafeResult struct {
	Status int
	Body   any
}

type IdempotencyOutcome string

const (
	IdempotencyCreated  IdempotencyOutcome = "created"
	IdempotencyReplayed IdempotencyOutcome = "replayed"
)

type IdempotencyExecutor struct {
	pool *pgxpool.Pool
	ttl  time.Duration
}

func NewIdempotencyExecutor(pool *pgxpool.Pool) *IdempotencyExecutor {
	return &IdempotencyExecutor{pool: pool, ttl: 24 * time.Hour}
}

// Cleanup removes a bounded batch of expired terminal records. In-progress
// records are deliberately retained: a retry must not race a live command.
func (e *IdempotencyExecutor) Cleanup(ctx context.Context, limit int) (int64, error) {
	if limit < 1 {
		return 0, nil
	}
	result, err := e.pool.Exec(ctx, `
		DELETE FROM idempotency_records
		WHERE ctid IN (
			SELECT ctid FROM idempotency_records
			WHERE status IN ('completed', 'failed') AND expires_at <= NOW()
			ORDER BY expires_at
			LIMIT $1
		)
	`, limit)
	if err != nil {
		return 0, fmt.Errorf("cleanup idempotency records: %w", err)
	}
	return result.RowsAffected(), nil
}

func IsIdempotentCreationRoute(route string) bool {
	switch route {
	case "POST /organizations", "POST /organizations/{organizationId}/invitations", "POST /organizations/{organizationId}/groups", "POST /groups/{groupId}/members", "POST /organizations/{organizationId}/workspaces":
		return true
	default:
		return false
	}
}

func CanonicalFingerprint(route string, request any) (string, error) {
	return CanonicalTargetFingerprint(route, nil, request)
}

func CanonicalTargetFingerprint(route string, targets []string, request any) (string, error) {
	payload, err := json.Marshal(struct {
		Route   string   `json:"route"`
		Targets []string `json:"targets"`
		Request any      `json:"request"`
	}{route, targets, request})
	if err != nil {
		return "", fmt.Errorf("marshal idempotency payload: %w", err)
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func (e *IdempotencyExecutor) Execute(ctx context.Context, identity IdempotencyIdentity, authorize func(context.Context, pgx.Tx) error, command func(context.Context, pgx.Tx) (SafeResult, error)) (SafeResult, IdempotencyOutcome, error) {
	if strings.TrimSpace(identity.PrincipalID) == "" || strings.TrimSpace(identity.Key) == "" || len(identity.Key) > 255 {
		return SafeResult{}, "", fmt.Errorf("invalid idempotency key")
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return SafeResult{}, "", fmt.Errorf("begin idempotency tx: %w", err)
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, identity.PrincipalID+"|"+identity.Method+"|"+identity.Route+"|"+identity.Key).Scan(&locked); err != nil {
		return SafeResult{}, "", err
	}
	if !locked {
		return SafeResult{}, "", ErrIdempotencyInProgress
	}
	if err := authorize(ctx, tx); err != nil {
		return SafeResult{}, "", err
	}
	var fingerprint string
	var status string
	var responseStatus *int
	var safeResponse []byte
	err = tx.QueryRow(ctx, `SELECT fingerprint,status,response_status,safe_response FROM idempotency_records WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4 FOR UPDATE`, identity.PrincipalID, identity.Method, identity.Route, identity.Key).Scan(&fingerprint, &status, &responseStatus, &safeResponse)
	if err == nil {
		if fingerprint != identity.Fingerprint {
			return SafeResult{}, "", ErrIdempotencyKeyConflict
		}
		if status == "completed" {
			var body any
			if json.Unmarshal(safeResponse, &body) != nil || responseStatus == nil {
				return SafeResult{}, "", fmt.Errorf("invalid stored idempotency response")
			}
			return SafeResult{Status: *responseStatus, Body: body}, IdempotencyReplayed, tx.Commit(ctx)
		}
		if status == "failed" {
			_, err = tx.Exec(ctx, `UPDATE idempotency_records SET status='in_progress',created_at=NOW(),expires_at=NOW()+$5::interval,response_status=NULL,safe_response=NULL,completed_at=NULL WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4`, identity.PrincipalID, identity.Method, identity.Route, identity.Key, e.ttl.String())
		} else {
			return SafeResult{}, "", ErrIdempotencyInProgress
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,expires_at) VALUES ($1,$2,$3,$4,$5,'in_progress',NOW()+$6::interval)`, identity.PrincipalID, identity.Method, identity.Route, identity.Key, identity.Fingerprint, e.ttl.String())
	}
	if err != nil {
		return SafeResult{}, "", err
	}
	result, err := command(ctx, tx)
	if err != nil {
		return SafeResult{}, "", err
	}
	if result.Status != 201 {
		return SafeResult{}, "", fmt.Errorf("unsafe idempotency response status")
	}
	body, err := json.Marshal(result.Body)
	if err != nil {
		return SafeResult{}, "", err
	}
	_, err = tx.Exec(ctx, `UPDATE idempotency_records SET status='completed',response_status=201,safe_response=$5,completed_at=NOW() WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4`, identity.PrincipalID, identity.Method, identity.Route, identity.Key, body)
	if err != nil {
		return SafeResult{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return SafeResult{}, "", err
	}
	return result, IdempotencyCreated, nil
}

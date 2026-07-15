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

type IdempotencyScope struct {
	PrincipalID string
	Method      string
	Route       string
	Key         string
}

type PostCommit func(context.Context) error

type Command func(context.Context, pgx.Tx) (SafeResult, PostCommit, error)

type Prepared struct {
	Fingerprint string
	Command     Command
}

type Prepare func(context.Context, pgx.Tx) (Prepared, error)

type SafeResult struct {
	Status    int
	Body      any
	Headers   map[string]string
	AckCursor *int64
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
	result, outcome, _, err := e.ExecutePrepared(ctx, IdempotencyScope{PrincipalID: identity.PrincipalID, Method: identity.Method, Route: identity.Route, Key: identity.Key}, func(ctx context.Context, tx pgx.Tx) (Prepared, error) {
		if err := authorize(ctx, tx); err != nil {
			return Prepared{}, err
		}
		return Prepared{Fingerprint: identity.Fingerprint, Command: func(ctx context.Context, tx pgx.Tx) (SafeResult, PostCommit, error) {
			result, err := command(ctx, tx)
			return result, nil, err
		}}, nil
	})
	return result, outcome, err
}

// ExecutePrepared authorizes and canonicalizes inside its receipt transaction.
// Prepare must not mutate or publish; Command is called only for a new receipt.
func (e *IdempotencyExecutor) ExecutePrepared(ctx context.Context, scope IdempotencyScope, prepare Prepare) (SafeResult, IdempotencyOutcome, PostCommit, error) {
	if strings.TrimSpace(scope.PrincipalID) == "" || strings.TrimSpace(scope.Method) == "" || strings.TrimSpace(scope.Route) == "" || strings.TrimSpace(scope.Key) == "" || len(scope.Key) > 255 || prepare == nil {
		return SafeResult{}, "", nil, fmt.Errorf("invalid idempotency scope")
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return SafeResult{}, "", nil, fmt.Errorf("begin idempotency tx: %w", err)
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, scope.PrincipalID+"|"+scope.Method+"|"+scope.Route+"|"+scope.Key).Scan(&locked); err != nil {
		return SafeResult{}, "", nil, err
	}
	if !locked {
		return SafeResult{}, "", nil, ErrIdempotencyInProgress
	}
	prepared, err := prepare(ctx, tx)
	if err != nil {
		return SafeResult{}, "", nil, err
	}
	if strings.TrimSpace(prepared.Fingerprint) == "" || prepared.Command == nil {
		return SafeResult{}, "", nil, fmt.Errorf("invalid prepared idempotency command")
	}
	replayed, found, err := e.claimReceipt(ctx, tx, scope, prepared.Fingerprint)
	if err != nil {
		return SafeResult{}, "", nil, err
	}
	if found {
		return replayed, IdempotencyReplayed, nil, tx.Commit(ctx)
	}
	result, hook, err := prepared.Command(ctx, tx)
	if err != nil {
		return SafeResult{}, "", nil, err
	}
	if err := e.completeReceipt(ctx, tx, scope, result); err != nil {
		return SafeResult{}, "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SafeResult{}, "", nil, err
	}
	return result, IdempotencyCreated, hook, nil
}

func (e *IdempotencyExecutor) claimReceipt(ctx context.Context, tx pgx.Tx, scope IdempotencyScope, expectedFingerprint string) (SafeResult, bool, error) {
	var fingerprint string
	var status string
	var responseStatus *int
	var safeResponse []byte
	var responseHeaders []byte
	var ackCursor *int64
	err := tx.QueryRow(ctx, `SELECT fingerprint,status,response_status,safe_response,response_headers,ack_cursor FROM idempotency_records WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4 FOR UPDATE`, scope.PrincipalID, scope.Method, scope.Route, scope.Key).Scan(&fingerprint, &status, &responseStatus, &safeResponse, &responseHeaders, &ackCursor)
	if err == nil {
		if fingerprint != expectedFingerprint {
			return SafeResult{}, false, ErrIdempotencyKeyConflict
		}
		if status == "completed" {
			var body any
			if json.Unmarshal(safeResponse, &body) != nil || responseStatus == nil {
				return SafeResult{}, false, fmt.Errorf("invalid stored idempotency response")
			}
			var headers map[string]string
			if responseHeaders != nil && json.Unmarshal(responseHeaders, &headers) != nil {
				return SafeResult{}, false, fmt.Errorf("invalid stored idempotency headers")
			}
			return SafeResult{Status: *responseStatus, Body: body, Headers: headers, AckCursor: ackCursor}, true, nil
		}
		if status == "failed" {
			_, err = tx.Exec(ctx, `UPDATE idempotency_records SET status='in_progress',created_at=NOW(),expires_at=NOW()+$5::interval,response_status=NULL,safe_response=NULL,response_headers=NULL,ack_cursor=NULL,completed_at=NULL WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4`, scope.PrincipalID, scope.Method, scope.Route, scope.Key, e.ttl.String())
		} else {
			return SafeResult{}, false, ErrIdempotencyInProgress
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,expires_at) VALUES ($1,$2,$3,$4,$5,'in_progress',NOW()+$6::interval)`, scope.PrincipalID, scope.Method, scope.Route, scope.Key, expectedFingerprint, e.ttl.String())
	}
	if err != nil {
		return SafeResult{}, false, err
	}
	return SafeResult{}, false, nil
}

func (e *IdempotencyExecutor) completeReceipt(ctx context.Context, tx pgx.Tx, scope IdempotencyScope, result SafeResult) error {
	if result.Status != 200 && result.Status != 201 {
		return fmt.Errorf("unsafe idempotency response status")
	}
	body, err := json.Marshal(result.Body)
	if err != nil {
		return err
	}
	var headers []byte
	if result.Headers != nil {
		headers, err = json.Marshal(result.Headers)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE idempotency_records SET status='completed',response_status=$5,safe_response=$6,response_headers=$7,ack_cursor=$8,completed_at=NOW() WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4`, scope.PrincipalID, scope.Method, scope.Route, scope.Key, result.Status, body, headers, result.AckCursor)
	return err
}

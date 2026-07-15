package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIdempotencyExecutorPostgresContracts(t *testing.T) {
	ctx, pool := openIdempotencyTestPool(t)
	executor := NewIdempotencyExecutor(pool)
	executor.ttl = time.Minute
	principalA := seedIdempotencyPrincipal(t, ctx, pool, "principal-a@example.com")
	principalB := seedIdempotencyPrincipal(t, ctx, pool, "principal-b@example.com")
	failedPrincipal := seedIdempotencyPrincipal(t, ctx, pool, "failed-principal@example.com")
	expiredPrincipal := seedIdempotencyPrincipal(t, ctx, pool, "expired-principal@example.com")
	inProgressPrincipal := seedIdempotencyPrincipal(t, ctx, pool, "in-progress-principal@example.com")
	concurrentPrincipal := seedIdempotencyPrincipal(t, ctx, pool, "concurrent-principal@example.com")
	identity := IdempotencyIdentity{PrincipalID: principalA, Method: "POST", Route: "POST /organizations", Key: "same-key", Fingerprint: "fingerprint-a"}
	created := 0
	allow := func(context.Context, pgx.Tx) error { return nil }
	command := func(context.Context, pgx.Tx) (SafeResult, error) {
		created++
		return SafeResult{Status: 201, Body: map[string]string{"organizationId": "org-1", "organizationName": "Safe", "role": "owner"}}, nil
	}

	first, outcome, err := executor.Execute(ctx, identity, allow, command)
	if err != nil || outcome != IdempotencyCreated || created != 1 {
		t.Fatalf("first result=%#v outcome=%q created=%d err=%v", first, outcome, created, err)
	}
	replayed, outcome, err := executor.Execute(ctx, identity, allow, command)
	if err != nil || outcome != IdempotencyReplayed || created != 1 {
		t.Fatalf("replay result=%#v outcome=%q created=%d err=%v", replayed, outcome, created, err)
	}
	if _, _, err := executor.Execute(ctx, IdempotencyIdentity{PrincipalID: identity.PrincipalID, Method: identity.Method, Route: identity.Route, Key: identity.Key, Fingerprint: "different"}, allow, command); !errors.Is(err, ErrIdempotencyKeyConflict) {
		t.Fatalf("mismatch err=%v", err)
	}

	// Principal and canonical route scope identities independently.
	for _, scoped := range []IdempotencyIdentity{{PrincipalID: principalB, Method: "POST", Route: identity.Route, Key: identity.Key, Fingerprint: identity.Fingerprint}, {PrincipalID: identity.PrincipalID, Method: "POST", Route: "POST /organizations/{organizationId}/groups", Key: identity.Key, Fingerprint: identity.Fingerprint}} {
		if _, _, err := executor.Execute(ctx, scoped, allow, command); err != nil {
			t.Fatalf("scoped request: %v", err)
		}
	}
	if created != 3 {
		t.Fatalf("created=%d, want 3", created)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,expires_at) VALUES ($1,$2,$3,$4,$5,'failed',NOW()-INTERVAL '1 minute')`, failedPrincipal, "POST", identity.Route, "failed-key", "failed-fingerprint"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executor.Execute(ctx, IdempotencyIdentity{PrincipalID: failedPrincipal, Method: "POST", Route: identity.Route, Key: "failed-key", Fingerprint: "failed-fingerprint"}, allow, command); err != nil {
		t.Fatalf("reclaim failed row: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,expires_at,completed_at,response_status,safe_response) VALUES ($1,'PATCH',$3,'expired-key','x','completed',NOW()-INTERVAL '1 minute',NOW(),200,'{}'::jsonb), ($2,'POST',$3,'in-progress-key','x','in_progress',NOW()-INTERVAL '1 minute',NULL,NULL,NULL)`, expiredPrincipal, inProgressPrincipal, identity.Route); err != nil {
		t.Fatal(err)
	}
	if deleted, err := executor.Cleanup(ctx, 10); err != nil || deleted != 1 {
		t.Fatalf("cleanup deleted=%d err=%v", deleted, err)
	}

	// A held advisory transaction lock makes the duplicate deterministic and prevents its command.
	concurrent := IdempotencyIdentity{PrincipalID: concurrentPrincipal, Method: "POST", Route: identity.Route, Key: "concurrent-key", Fingerprint: "concurrent-fingerprint"}
	started := make(chan struct{})
	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _, err := executor.Execute(ctx, concurrent, allow, func(ctx context.Context, tx pgx.Tx) (SafeResult, error) {
			close(started)
			<-release
			return command(ctx, tx)
		})
		if err != nil {
			t.Errorf("first concurrent: %v", err)
		}
	}()
	<-started
	if _, _, err := executor.Execute(ctx, concurrent, allow, command); !errors.Is(err, ErrIdempotencyInProgress) {
		t.Fatalf("in-flight err=%v", err)
	}
	close(release)
	wg.Wait()
}

func TestIdempotencyExecutorAuthorizesBeforeReplay(t *testing.T) {
	ctx, pool := openIdempotencyTestPool(t)
	executor := NewIdempotencyExecutor(pool)
	identity := IdempotencyIdentity{PrincipalID: seedIdempotencyPrincipal(t, ctx, pool, "revoked-principal@example.com"), Method: "POST", Route: "POST /organizations|", Key: "revoked-key", Fingerprint: "fingerprint"}
	if _, err := pool.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,response_status,safe_response,completed_at,expires_at) VALUES ($1,$2,$3,$4,$5,'completed',201,'{"secret":"stored response"}'::jsonb,NOW(),NOW()+INTERVAL '1 hour')`, identity.PrincipalID, identity.Method, identity.Route, identity.Key, identity.Fingerprint); err != nil {
		t.Fatal(err)
	}
	authorized := 0
	created := 0
	_, outcome, err := executor.Execute(ctx, identity, func(context.Context, pgx.Tx) error {
		authorized++
		return errors.New("forbidden")
	}, func(context.Context, pgx.Tx) (SafeResult, error) {
		created++
		return SafeResult{Status: 201, Body: map[string]string{"secret": "new response"}}, nil
	})
	if err == nil || err.Error() != "forbidden" {
		t.Fatalf("err=%v, want forbidden", err)
	}
	if outcome != "" || authorized != 1 || created != 0 {
		t.Fatalf("outcome=%q authorized=%d created=%d", outcome, authorized, created)
	}
}

func TestIdempotencyExecutorReplaysSafe200Receipt(t *testing.T) {
	ctx, pool := openIdempotencyTestPool(t)
	executor := NewIdempotencyExecutor(pool)
	principal := seedIdempotencyPrincipal(t, ctx, pool, "receipt-principal@example.com")
	identity := IdempotencyIdentity{PrincipalID: principal, Method: "PATCH", Route: "PATCH /workspaces/folders|folder-1", Key: "receipt-key", Fingerprint: "canonical-shape"}
	ackCursor := int64(7)
	calls := 0
	command := func(context.Context, pgx.Tx) (SafeResult, error) {
		calls++
		return SafeResult{Status: 200, Body: map[string]any{"id": "folder-1", "name": "Canonical"}, Headers: map[string]string{"X-Sync-Event-Id": "receipt-key", "X-Sync-Cursor": "7"}, AckCursor: &ackCursor}, nil
	}

	first, outcome, err := executor.Execute(ctx, identity, func(context.Context, pgx.Tx) error { return nil }, command)
	if err != nil || outcome != IdempotencyCreated || first.Status != 200 || calls != 1 {
		t.Fatalf("first=%#v outcome=%q calls=%d err=%v", first, outcome, calls, err)
	}
	ackCursor = 99 // A later cursor-like value must not alter the stored acknowledgement.
	replayed, outcome, err := executor.Execute(ctx, identity, func(context.Context, pgx.Tx) error { return nil }, command)
	if err != nil || outcome != IdempotencyReplayed || calls != 1 || replayed.Headers["X-Sync-Cursor"] != "7" || replayed.AckCursor == nil || *replayed.AckCursor != 7 {
		t.Fatalf("replayed=%#v outcome=%q calls=%d err=%v", replayed, outcome, calls, err)
	}
	if _, _, err := executor.Execute(ctx, IdempotencyIdentity{PrincipalID: principal, Method: identity.Method, Route: identity.Route, Key: identity.Key, Fingerprint: "other-shape"}, func(context.Context, pgx.Tx) error { return nil }, command); !errors.Is(err, ErrIdempotencyKeyConflict) {
		t.Fatalf("incompatible receipt err=%v", err)
	}
}

func TestIdempotencyExecutorRollsBackIncompleteReceipt(t *testing.T) {
	ctx, pool := openIdempotencyTestPool(t)
	executor := NewIdempotencyExecutor(pool)
	identity := IdempotencyIdentity{PrincipalID: seedIdempotencyPrincipal(t, ctx, pool, "rollback-principal@example.com"), Method: "PATCH", Route: "PATCH /workspaces/folders|folder-1", Key: "rollback-key", Fingerprint: "shape"}
	if _, _, err := executor.Execute(ctx, identity, func(context.Context, pgx.Tx) error { return nil }, func(context.Context, pgx.Tx) (SafeResult, error) {
		return SafeResult{}, errors.New("crash before commit")
	}); err == nil {
		t.Fatal("crashed command succeeded")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_records WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4`, identity.PrincipalID, identity.Method, identity.Route, identity.Key).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial receipt count=%d err=%v", count, err)
	}
	if _, outcome, err := executor.Execute(ctx, identity, func(context.Context, pgx.Tx) error { return nil }, func(context.Context, pgx.Tx) (SafeResult, error) {
		return SafeResult{Status: 200, Body: map[string]string{"id": "folder-1"}}, nil
	}); err != nil || outcome != IdempotencyCreated {
		t.Fatalf("retry outcome=%q err=%v", outcome, err)
	}
}

func TestIdempotencyExecutorAuthorizesBeforeLedgerLookup(t *testing.T) {
	ctx, pool := openIdempotencyTestPool(t)
	executor := NewIdempotencyExecutor(pool)
	identity := IdempotencyIdentity{PrincipalID: seedIdempotencyPrincipal(t, ctx, pool, "ordering-principal@example.com"), Method: "POST", Route: "POST /organizations|", Key: "ordering-key", Fingerprint: "fingerprint"}
	if _, err := pool.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,response_status,safe_response,completed_at,expires_at) VALUES ($1,$2,$3,$4,$5,'completed',201,'{"stored":"response"}'::jsonb,NOW(),NOW()+INTERVAL '1 hour')`, identity.PrincipalID, identity.Method, identity.Route, identity.Key, identity.Fingerprint); err != nil {
		t.Fatal(err)
	}
	created := 0
	result, outcome, err := executor.Execute(ctx, identity, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM idempotency_records WHERE principal_id=$1 AND method=$2 AND route=$3 AND key=$4`, identity.PrincipalID, identity.Method, identity.Route, identity.Key)
		return err
	}, func(context.Context, pgx.Tx) (SafeResult, error) {
		created++
		return SafeResult{Status: 201, Body: map[string]string{"fresh": "response"}}, nil
	})
	if err != nil || outcome != IdempotencyCreated || created != 1 {
		t.Fatalf("result=%#v outcome=%q created=%d err=%v", result, outcome, created, err)
	}
}

func TestExecutePreparedPostgresContracts(t *testing.T) {
	ctx, pool := openIdempotencyTestPool(t)
	executor := NewIdempotencyExecutor(pool)
	principal := seedIdempotencyPrincipal(t, ctx, pool, "prepared-principal@example.com")
	if _, err := pool.Exec(ctx, `CREATE TABLE prepared_evidence (value text NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	scope := IdempotencyScope{PrincipalID: principal, Method: "PATCH", Route: "PATCH /prepared|one", Key: "prepared-key"}
	prepareCalls, commandCalls, hookCalls := 0, 0, 0
	prepare := func(ctx context.Context, tx pgx.Tx) (Prepared, error) {
		prepareCalls++
		if _, err := tx.Exec(ctx, `CREATE TEMP TABLE prepared_tx_evidence (value text) ON COMMIT DROP; INSERT INTO prepared_tx_evidence VALUES ('prepared')`); err != nil {
			return Prepared{}, err
		}
		return Prepared{Fingerprint: "shape-a", Command: func(ctx context.Context, tx pgx.Tx) (SafeResult, PostCommit, error) {
			commandCalls++
			var value string
			if err := tx.QueryRow(ctx, `SELECT value FROM prepared_tx_evidence`).Scan(&value); err != nil || value != "prepared" {
				return SafeResult{}, nil, fmt.Errorf("prepared evidence: %w", err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO prepared_evidence VALUES ('created')`); err != nil {
				return SafeResult{}, nil, err
			}
			return SafeResult{Status: 200, Body: map[string]string{"value": value}}, func(context.Context) error { hookCalls++; return nil }, nil
		}}, nil
	}

	created, outcome, hook, err := executor.ExecutePrepared(ctx, scope, prepare)
	if err != nil || outcome != IdempotencyCreated || created.Status != 200 || commandCalls != 1 || hook == nil || hookCalls != 0 {
		t.Fatalf("created=%#v outcome=%q command=%d hook=%v called=%d err=%v", created, outcome, commandCalls, hook != nil, hookCalls, err)
	}
	if err := hook(ctx); err != nil || hookCalls != 1 {
		t.Fatalf("post-commit hook err=%v calls=%d", err, hookCalls)
	}
	replayed, outcome, hook, err := executor.ExecutePrepared(ctx, scope, prepare)
	if err != nil || outcome != IdempotencyReplayed || replayed.Status != 200 || prepareCalls != 2 || commandCalls != 1 || hook != nil {
		t.Fatalf("replayed=%#v outcome=%q prepare=%d command=%d hook=%v err=%v", replayed, outcome, prepareCalls, commandCalls, hook != nil, err)
	}
	if _, _, _, err := executor.ExecutePrepared(ctx, scope, func(context.Context, pgx.Tx) (Prepared, error) {
		return Prepared{Fingerprint: "shape-b", Command: func(context.Context, pgx.Tx) (SafeResult, PostCommit, error) {
			commandCalls++
			return SafeResult{}, nil, nil
		}}, nil
	}); !errors.Is(err, ErrIdempotencyKeyConflict) || commandCalls != 1 {
		t.Fatalf("conflict err=%v command=%d", err, commandCalls)
	}

	denied := IdempotencyScope{PrincipalID: principal, Method: "PATCH", Route: "PATCH /prepared|denied", Key: "denied-key"}
	if _, err := pool.Exec(ctx, `INSERT INTO idempotency_records (principal_id,method,route,key,fingerprint,status,response_status,safe_response,completed_at,expires_at) VALUES ($1,$2,$3,$4,'shape','completed',200,'{"stored":"secret"}'::jsonb,NOW(),NOW()+INTERVAL '1 hour')`, denied.PrincipalID, denied.Method, denied.Route, denied.Key); err != nil {
		t.Fatal(err)
	}
	if result, _, _, err := executor.ExecutePrepared(ctx, denied, func(context.Context, pgx.Tx) (Prepared, error) { return Prepared{}, errors.New("forbidden") }); err == nil || result.Body != nil {
		t.Fatalf("denied result=%#v err=%v", result, err)
	}

	for _, tc := range []struct {
		key string
		err error
	}{
		{"command-error", errors.New("command failed")},
		{"completion-error", nil},
	} {
		t.Run(tc.key, func(t *testing.T) {
			rollback := IdempotencyScope{PrincipalID: principal, Method: "PATCH", Route: "PATCH /prepared|rollback", Key: tc.key}
			_, _, _, err := executor.ExecutePrepared(ctx, rollback, func(ctx context.Context, tx pgx.Tx) (Prepared, error) {
				return Prepared{Fingerprint: tc.key, Command: func(ctx context.Context, tx pgx.Tx) (SafeResult, PostCommit, error) {
					_, _ = tx.Exec(ctx, `INSERT INTO prepared_evidence VALUES ($1)`, tc.key)
					if tc.err != nil {
						return SafeResult{}, nil, tc.err
					}
					return SafeResult{Status: 200, Body: make(chan int)}, nil, nil
				}}, nil
			})
			if err == nil {
				t.Fatal("failed execution succeeded")
			}
			var evidence, receipts int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM prepared_evidence WHERE value=$1`, tc.key).Scan(&evidence); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_records WHERE principal_id=$1 AND key=$2`, principal, tc.key).Scan(&receipts); err != nil || evidence != 0 || receipts != 0 {
				t.Fatalf("evidence=%d receipts=%d err=%v", evidence, receipts, err)
			}
			if _, outcome, _, err := executor.ExecutePrepared(ctx, rollback, func(context.Context, pgx.Tx) (Prepared, error) {
				return Prepared{Fingerprint: tc.key, Command: func(context.Context, pgx.Tx) (SafeResult, PostCommit, error) {
					return SafeResult{Status: 200, Body: map[string]string{"retry": "ok"}}, nil, nil
				}}, nil
			}); err != nil || outcome != IdempotencyCreated {
				t.Fatalf("retry outcome=%q err=%v", outcome, err)
			}
		})
	}
}

func openIdempotencyTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("ADMIN_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("ADMIN_TEST_DATABASE_URL is required for PostgreSQL idempotency evidence")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if err := admin.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	schema := "idempotency_" + strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(ctx, pool, filepath.Clean(filepath.Join("..", "..", "migrations"))); err != nil {
		t.Fatal(err)
	}
	return ctx, pool
}

func seedIdempotencyPrincipal(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var userID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (email,password_hash) VALUES ($1, 'hash') RETURNING id`, email).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	return userID
}

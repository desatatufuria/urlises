package purge

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Task 3.1 — RED: Window is the single shared 30-day recovery constant,
// consumed by both the Trash countdown (purgeAt = deletedAt + Window, in
// organizations.ListDeletedOrganizations and workspaces.ListDeleted) and the
// purge sweep below. Pure structural check: one constant, no branching, so
// a single assertion is exhaustive.
// Triangulation skipped: there is only one possible value for a const.
func TestWindowIsThirtyDays(t *testing.T) {
	t.Parallel()

	want := 30 * 24 * time.Hour
	if Window != want {
		t.Fatalf("Window = %v, want %v", Window, want)
	}
}

// -----------------------------------------------------------------------
// Pure, DB-free tests: the log line format itself. These never need a
// live Postgres connection and prove the exact `event=key value` shape
// (httpapi/errors.go's idiom) independently of the sweep transaction.
// -----------------------------------------------------------------------

func TestLogSweepCompletedFormat(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		result Result
		want   string
	}{
		{
			name:   "non-empty sweep",
			result: Result{Organizations: 3, Workspaces: 5},
			want:   "event=purge_sweep_completed organizations=3 workspaces=5 duration_ms=42\n",
		},
		{
			name:   "zero-count heartbeat sweep",
			result: Result{Organizations: 0, Workspaces: 0},
			want:   "event=purge_sweep_completed organizations=0 workspaces=0 duration_ms=42\n",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var logs bytes.Buffer
			logSweepCompleted(&logs, tc.result, 42*time.Millisecond)

			if got := logs.String(); got != tc.want {
				t.Fatalf("log line = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestLogSweepFailedFormat(t *testing.T) {
	t.Parallel()

	const rawError = "pgx: password=unsafe"
	var logs bytes.Buffer
	logSweepFailed(&logs)

	got := logs.String()
	if got != "event=purge_sweep_failed\n" {
		t.Fatalf("log line = %q, want exactly %q", got, "event=purge_sweep_failed\n")
	}
	if strings.Contains(got, rawError) || strings.Contains(got, "%v") || strings.Contains(got, "%w") {
		t.Fatalf("logs=%q leaked error detail, want no detail", got)
	}
}

// -----------------------------------------------------------------------
// DB-backed tests. Mirror workspaces/service_integration_test.go's
// openXTestPool skip pattern: these SKIP cleanly when no local Postgres
// is available this session (testing.Short() or missing DATABASE_URL).
// -----------------------------------------------------------------------

func TestSweepPurgesRowsPastWindowIncludingCascadedChildren(t *testing.T) {
	t.Parallel()

	ctx, pool := openPurgeTestPool(t)
	sweeper := NewSweeper(pool, &bytes.Buffer{})

	userID := insertPurgeTestUser(t, ctx, pool, "owner@example.com")

	organizationID := insertPurgeTestOrganization(t, ctx, pool, "Trashed Org")
	insertPurgeTestMember(t, ctx, pool, organizationID, userID, "owner")
	orgWorkspaceID := insertPurgeTestWorkspace(t, ctx, pool, organizationID, "Org-owned space")
	backdatePurgeTestOrganizationDeletedAt(t, ctx, pool, organizationID, Window+time.Hour)

	standaloneWorkspaceOrgID := insertPurgeTestOrganization(t, ctx, pool, "Live Org")
	standaloneWorkspaceID := insertPurgeTestWorkspace(t, ctx, pool, standaloneWorkspaceOrgID, "Individually trashed space")
	insertPurgeTestFolder(t, ctx, pool, standaloneWorkspaceID, "Folder in trashed workspace")
	backdatePurgeTestWorkspaceDeletedAt(t, ctx, pool, standaloneWorkspaceID, Window+time.Hour)

	result, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if result.Organizations != 1 {
		t.Fatalf("Organizations purged = %d, want 1", result.Organizations)
	}
	if result.Workspaces != 1 {
		t.Fatalf("Workspaces purged = %d, want 1 (only the individually-deleted workspace, not the cascaded one)", result.Workspaces)
	}

	if countPurgeTestRows(t, ctx, pool, "organizations", organizationID) != 0 {
		t.Fatal("expected purged organization row to be gone")
	}
	if countPurgeTestRowsByColumn(t, ctx, pool, "organization_members", "organization_id", organizationID) != 0 {
		t.Fatal("expected organization_members to cascade away with the purged organization")
	}
	if countPurgeTestRowsByColumn(t, ctx, pool, "workspaces", "organization_id", organizationID) != 0 {
		t.Fatal("expected org-owned workspace to cascade away with the purged organization")
	}
	if countPurgeTestRows(t, ctx, pool, "workspaces", standaloneWorkspaceID) != 0 {
		t.Fatal("expected individually-purged workspace row to be gone")
	}
	if countPurgeTestRowsByColumn(t, ctx, pool, "folders", "workspace_id", standaloneWorkspaceID) != 0 {
		t.Fatal("expected folders to cascade away with the purged workspace")
	}
	_ = orgWorkspaceID
}

func TestSweepLeavesRowsWithinWindowUntouched(t *testing.T) {
	t.Parallel()

	ctx, pool := openPurgeTestPool(t)
	sweeper := NewSweeper(pool, &bytes.Buffer{})

	organizationID := insertPurgeTestOrganization(t, ctx, pool, "Recently Trashed Org")
	backdatePurgeTestOrganizationDeletedAt(t, ctx, pool, organizationID, Window-time.Hour)

	workspaceOrgID := insertPurgeTestOrganization(t, ctx, pool, "Live Org For Workspace")
	workspaceID := insertPurgeTestWorkspace(t, ctx, pool, workspaceOrgID, "Recently trashed space")
	backdatePurgeTestWorkspaceDeletedAt(t, ctx, pool, workspaceID, Window-time.Hour)

	result, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if result.Organizations != 0 || result.Workspaces != 0 {
		t.Fatalf("result = %+v, want zero — rows are inside the recovery window", result)
	}
	if countPurgeTestRows(t, ctx, pool, "organizations", organizationID) != 1 {
		t.Fatal("expected in-window organization row to survive")
	}
	if countPurgeTestRows(t, ctx, pool, "workspaces", workspaceID) != 1 {
		t.Fatal("expected in-window workspace row to survive")
	}
}

func TestSweepEmptyReturnsZeroResultAndNoError(t *testing.T) {
	t.Parallel()

	ctx, pool := openPurgeTestPool(t)
	sweeper := NewSweeper(pool, &bytes.Buffer{})

	// No trashed rows exist at all in this fresh schema.
	result, err := sweeper.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if result != (Result{}) {
		t.Fatalf("result = %+v, want zero value", result)
	}
}

func TestSweepCancelledContextAbortsWithoutPartialCommit(t *testing.T) {
	t.Parallel()

	ctx, pool := openPurgeTestPool(t)
	sweeper := NewSweeper(pool, &bytes.Buffer{})

	organizationID := insertPurgeTestOrganization(t, ctx, pool, "Should Not Be Purged")
	backdatePurgeTestOrganizationDeletedAt(t, ctx, pool, organizationID, Window+time.Hour)

	cancelledCtx, cancel := context.WithCancel(ctx)
	cancel()

	_, err := sweeper.Sweep(cancelledCtx)
	if err == nil {
		t.Fatal("expected Sweep to fail on a cancelled context")
	}
	if countPurgeTestRows(t, ctx, pool, "organizations", organizationID) != 1 {
		t.Fatal("expected the purge-eligible row to survive an aborted sweep — no partial commit")
	}
}

func TestSweepLogsCompletionEventOnEveryCall(t *testing.T) {
	t.Parallel()

	ctx, pool := openPurgeTestPool(t)
	var logs bytes.Buffer
	sweeper := NewSweeper(pool, &logs)

	if _, err := sweeper.Sweep(ctx); err != nil {
		t.Fatalf("Sweep: %v", err)
	}

	got := logs.String()
	if !strings.Contains(got, "event=purge_sweep_completed") {
		t.Fatalf("logs=%q, want event=purge_sweep_completed even for an empty sweep", got)
	}
	if !strings.Contains(got, "organizations=0 workspaces=0") {
		t.Fatalf("logs=%q, want organizations=0 workspaces=0 heartbeat", got)
	}
}

func TestRunFiresSweepOnEachTickAndReturnsPromptlyOnCancel(t *testing.T) {
	t.Parallel()

	ctx, pool := openPurgeTestPool(t)
	var logs bytes.Buffer
	sweeper := NewSweeper(pool, &logs)

	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		sweeper.Run(runCtx, 10*time.Millisecond)
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for !strings.Contains(logs.String(), "event=purge_sweep_completed") {
		select {
		case <-deadline:
			cancel()
			t.Fatal("Run did not fire a sweep within the deadline")
		case <-time.After(5 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return promptly after ctx cancellation")
	}
}

// -----------------------------------------------------------------------
// Fixture helpers — mirror workspaces/service_integration_test.go's
// openWorkspacesTestPool / insertWorkspacesTest* naming and shape.
// -----------------------------------------------------------------------

func openPurgeTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("PURGE_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set PURGE_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

	schemaName := fmt.Sprintf("purge_test_%d", time.Now().UnixNano())
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

func insertPurgeTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func insertPurgeTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
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

func insertPurgeTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func insertPurgeTestWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, name string) string {
	t.Helper()

	var workspaceID string
	err := pool.QueryRow(ctx, `
		INSERT INTO workspaces (organization_id, name, type)
		VALUES ($1, $2, 'operational')
		RETURNING id
	`, organizationID, name).Scan(&workspaceID)
	if err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	return workspaceID
}

func insertPurgeTestFolder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID, name string) string {
	t.Helper()

	var folderID string
	err := pool.QueryRow(ctx, `
		INSERT INTO folders (workspace_id, name)
		VALUES ($1, $2)
		RETURNING id
	`, workspaceID, name).Scan(&folderID)
	if err != nil {
		t.Fatalf("insert folder: %v", err)
	}
	return folderID
}

func backdatePurgeTestOrganizationDeletedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string, age time.Duration) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		UPDATE organizations SET deleted_at = NOW() - $2::interval WHERE id = $1
	`, organizationID, fmt.Sprintf("%d seconds", int64(age/time.Second))); err != nil {
		t.Fatalf("backdate organization deleted_at: %v", err)
	}
}

func backdatePurgeTestWorkspaceDeletedAt(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID string, age time.Duration) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		UPDATE workspaces SET deleted_at = NOW() - $2::interval WHERE id = $1
	`, workspaceID, fmt.Sprintf("%d seconds", int64(age/time.Second))); err != nil {
		t.Fatalf("backdate workspace deleted_at: %v", err)
	}
}

func countPurgeTestRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, id string) int {
	t.Helper()

	var count int
	if err := pool.QueryRow(ctx, fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE id = $1`, table), id).Scan(&count); err != nil {
		t.Fatalf("count %s rows: %v", table, err)
	}
	return count
}

func countPurgeTestRowsByColumn(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, column, value string) int {
	t.Helper()

	var count int
	query := fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE %s = $1`, table, column)
	if err := pool.QueryRow(ctx, query, value).Scan(&count); err != nil {
		t.Fatalf("count %s rows by %s: %v", table, column, err)
	}
	return count
}

package activity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRecordCommittedTransactionPersistsActivityRow(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_record_commit_test")
	service := NewService(pool)

	actorID := insertActivityTestUser(t, ctx, pool, "actor-commit@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "Commit Co")

	metadata := map[string]any{"groupName": "Engineering", "renamed": true}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}

	if err := service.Record(ctx, tx, organizationID, actorID, KindGroupCreated, "group", "group-commit-1", metadata); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	var (
		gotOrgID     string
		gotActorID   *string
		gotKind      string
		gotTargetTy  string
		gotTargetID  string
		gotMetaBytes []byte
		gotCreatedAt time.Time
	)
	err = pool.QueryRow(ctx, `
		SELECT organization_id, actor_user_id, kind, target_type, target_id, metadata, created_at
		FROM activity_events
		WHERE target_id = $1
	`, "group-commit-1").Scan(&gotOrgID, &gotActorID, &gotKind, &gotTargetTy, &gotTargetID, &gotMetaBytes, &gotCreatedAt)
	if err != nil {
		t.Fatalf("query persisted row: %v", err)
	}

	if gotOrgID != organizationID {
		t.Fatalf("organization_id = %q, want %q", gotOrgID, organizationID)
	}
	if gotActorID == nil || *gotActorID != actorID {
		t.Fatalf("actor_user_id = %v, want %q", gotActorID, actorID)
	}
	if gotKind != string(KindGroupCreated) {
		t.Fatalf("kind = %q, want %q", gotKind, KindGroupCreated)
	}
	if gotTargetTy != "group" {
		t.Fatalf("target_type = %q, want %q", gotTargetTy, "group")
	}
	if gotTargetID != "group-commit-1" {
		t.Fatalf("target_id = %q, want %q", gotTargetID, "group-commit-1")
	}
	if gotCreatedAt.IsZero() {
		t.Fatal("created_at is zero, want a real timestamp")
	}

	var gotMetadata map[string]any
	if err := json.Unmarshal(gotMetaBytes, &gotMetadata); err != nil {
		t.Fatalf("unmarshal stored metadata: %v", err)
	}
	if gotMetadata["groupName"] != "Engineering" {
		t.Fatalf("metadata[groupName] = %v, want %q", gotMetadata["groupName"], "Engineering")
	}
	if gotMetadata["renamed"] != true {
		t.Fatalf("metadata[renamed] = %v, want true", gotMetadata["renamed"])
	}
	if len(gotMetadata) != len(metadata) {
		t.Fatalf("metadata round-trip changed shape: got %v, want %v", gotMetadata, metadata)
	}
}

func TestRecordRolledBackTransactionLeavesNoOrphanRow(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_record_rollback_test")
	service := NewService(pool)

	actorID := insertActivityTestUser(t, ctx, pool, "actor-rollback@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "Rollback Co")

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}

	if err := service.Record(ctx, tx, organizationID, actorID, KindGroupDeleted, "group", "group-rollback-1", map[string]any{}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// Simulate the primary mutation failing after Record was called: the
	// caller rolls back instead of committing.
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback tx: %v", err)
	}

	var count int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM activity_events WHERE target_id = $1
	`, "group-rollback-1").Scan(&count); err != nil {
		t.Fatalf("count orphan rows: %v", err)
	}
	if count != 0 {
		t.Fatalf("orphan activity rows after rollback = %d, want 0", count)
	}
}

func TestListByOrganizationRejectsNonAdmin(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_nonadmin_test")
	service := NewService(pool)

	memberID := insertActivityTestUser(t, ctx, pool, "member-nonadmin@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "NonAdmin Co")
	insertActivityTestMember(t, ctx, pool, organizationID, memberID, "member")

	_, _, err := service.ListByOrganization(ctx, memberID, organizationID, "", 50)
	if err == nil {
		t.Fatal("expected non-admin ListByOrganization to be rejected")
	}
	if !errors.Is(err, access.ErrForbidden) {
		t.Fatalf("err = %v, want %v", err, access.ErrForbidden)
	}
}

func TestListByOrganizationAdminSeesRows(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_admin_test")
	service := NewService(pool)

	adminID := insertActivityTestUser(t, ctx, pool, "admin-sees-rows@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "Admin Sees Rows Co")
	insertActivityTestMember(t, ctx, pool, organizationID, adminID, "admin")

	insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group", "group-a", time.Now().UTC().Add(-time.Minute))

	events, _, err := service.ListByOrganization(ctx, adminID, organizationID, "", 50)
	if err != nil {
		t.Fatalf("ListByOrganization: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].TargetID != "group-a" {
		t.Fatalf("events[0].TargetID = %q, want %q", events[0].TargetID, "group-a")
	}
}

func TestListByOrganizationOnlyReturnsRowsForRequestedOrg(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_org_scope_test")
	service := NewService(pool)

	adminID := insertActivityTestUser(t, ctx, pool, "admin-org-scope@example.com")
	orgA := insertActivityTestOrganization(t, ctx, pool, "Org Scope A")
	orgB := insertActivityTestOrganization(t, ctx, pool, "Org Scope B")
	insertActivityTestMember(t, ctx, pool, orgA, adminID, "admin")

	insertActivityTestEvent(t, ctx, pool, orgA, adminID, KindGroupCreated, "group", "org-a-group", time.Now().UTC())
	insertActivityTestEvent(t, ctx, pool, orgB, adminID, KindGroupCreated, "group", "org-b-group", time.Now().UTC())

	events, _, err := service.ListByOrganization(ctx, adminID, orgA, "", 50)
	if err != nil {
		t.Fatalf("ListByOrganization: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].TargetID != "org-a-group" {
		t.Fatalf("events[0].TargetID = %q, want %q (org B event must never appear)", events[0].TargetID, "org-a-group")
	}
}

func TestListByOrganizationFirstPageCappedOrderedNewestFirst(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_firstpage_test")
	service := NewService(pool)

	adminID := insertActivityTestUser(t, ctx, pool, "admin-firstpage@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "First Page Co")
	insertActivityTestMember(t, ctx, pool, organizationID, adminID, "admin")

	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group",
			fmt.Sprintf("group-%d", i), base.Add(time.Duration(i)*time.Minute))
	}

	events, nextCursor, err := service.ListByOrganization(ctx, adminID, organizationID, "", 2)
	if err != nil {
		t.Fatalf("ListByOrganization: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("len(events) = %d, want 2", len(events))
	}
	if events[0].TargetID != "group-4" || events[1].TargetID != "group-3" {
		t.Fatalf("events = [%q, %q], want [group-4, group-3] (newest first)", events[0].TargetID, events[1].TargetID)
	}
	if nextCursor == "" {
		t.Fatal("nextCursor is empty, want a non-empty cursor since more rows remain")
	}
}

func TestListByOrganizationCursorAdvancesWithoutDuplicatesOrGaps(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_cursor_advance_test")
	service := NewService(pool)

	adminID := insertActivityTestUser(t, ctx, pool, "admin-cursor-advance@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "Cursor Advance Co")
	insertActivityTestMember(t, ctx, pool, organizationID, adminID, "admin")

	// Two rows share the exact same created_at to exercise the id DESC
	// tie-break in the ORDER BY / cursor predicate.
	tie := time.Now().UTC().Add(-time.Hour)
	insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group", "tie-1", tie)
	insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group", "tie-2", tie)
	insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group", "newest", tie.Add(time.Minute))

	page1, cursor1, err := service.ListByOrganization(ctx, adminID, organizationID, "", 2)
	if err != nil {
		t.Fatalf("ListByOrganization page1: %v", err)
	}
	if len(page1) != 2 {
		t.Fatalf("len(page1) = %d, want 2", len(page1))
	}
	if cursor1 == "" {
		t.Fatal("cursor1 is empty, want a non-empty cursor since a third row remains")
	}

	page2, cursor2, err := service.ListByOrganization(ctx, adminID, organizationID, cursor1, 2)
	if err != nil {
		t.Fatalf("ListByOrganization page2: %v", err)
	}
	if len(page2) != 1 {
		t.Fatalf("len(page2) = %d, want 1", len(page2))
	}
	if cursor2 != "" {
		t.Fatalf("cursor2 = %q, want empty (no further page)", cursor2)
	}

	seen := make(map[string]bool, 3)
	for _, e := range append(page1, page2...) {
		if seen[e.TargetID] {
			t.Fatalf("duplicate row across pages: %q", e.TargetID)
		}
		seen[e.TargetID] = true
	}
	for _, wantID := range []string{"tie-1", "tie-2", "newest"} {
		if !seen[wantID] {
			t.Fatalf("row %q missing across pages: gap in pagination", wantID)
		}
	}
}

func TestListByOrganizationLimitClampsToValidRange(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_limit_clamp_test")
	service := NewService(pool)

	adminID := insertActivityTestUser(t, ctx, pool, "admin-limit-clamp@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "Limit Clamp Co")
	insertActivityTestMember(t, ctx, pool, organizationID, adminID, "admin")

	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group",
			fmt.Sprintf("clamp-group-%d", i), base.Add(time.Duration(i)*time.Minute))
	}

	// limit <= 0 must clamp up to at least 1, never an unbounded/zero-row query.
	events, _, err := service.ListByOrganization(ctx, adminID, organizationID, "", 0)
	if err != nil {
		t.Fatalf("ListByOrganization limit=0: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) with limit=0 = %d, want 1 (clamped to minimum)", len(events))
	}

	// limit above the max (100) must clamp down, not return everything
	// unbounded; with only 3 rows this proves the cap didn't error or drop
	// legitimate rows below the actual count.
	events, _, err = service.ListByOrganization(ctx, adminID, organizationID, "", 1000)
	if err != nil {
		t.Fatalf("ListByOrganization limit=1000: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("len(events) with limit=1000 = %d, want 3", len(events))
	}
}

func TestListByOrganizationFirstPageWithNoCursorWorks(t *testing.T) {
	t.Parallel()

	ctx, pool := openActivityTestPool(t, "activity_list_no_cursor_test")
	service := NewService(pool)

	adminID := insertActivityTestUser(t, ctx, pool, "admin-no-cursor@example.com")
	organizationID := insertActivityTestOrganization(t, ctx, pool, "No Cursor Co")
	insertActivityTestMember(t, ctx, pool, organizationID, adminID, "admin")

	insertActivityTestEvent(t, ctx, pool, organizationID, adminID, KindGroupCreated, "group", "only-row", time.Now().UTC())

	events, nextCursor, err := service.ListByOrganization(ctx, adminID, organizationID, "", 50)
	if err != nil {
		t.Fatalf("ListByOrganization: %v", err)
	}
	if len(events) != 1 || events[0].TargetID != "only-row" {
		t.Fatalf("events = %+v, want a single only-row event", events)
	}
	if nextCursor != "" {
		t.Fatalf("nextCursor = %q, want empty (no further page)", nextCursor)
	}
}

// --- Test helpers (mirrors organizations' openOrganizationsTestPool pattern) ---

func openActivityTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration-style test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("ACTIVITY_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set ACTIVITY_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

func insertActivityTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func insertActivityTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
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

func insertActivityTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

// insertActivityTestEvent seeds an activity_events row directly (bypassing
// Record) so pagination/ordering fixtures can control created_at precisely,
// including forcing same-created_at ties for cursor tie-break coverage.
func insertActivityTestEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, actorUserID string, kind Kind, targetType, targetID string, createdAt time.Time) string {
	t.Helper()

	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO activity_events (organization_id, actor_user_id, kind, target_type, target_id, metadata, created_at)
		VALUES ($1, $2, $3, $4, $5, '{}', $6)
		RETURNING id
	`, organizationID, actorUserID, string(kind), targetType, targetID, createdAt).Scan(&id)
	if err != nil {
		t.Fatalf("insert activity event: %v", err)
	}

	return id
}

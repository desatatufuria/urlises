package organizations

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrationFrom000002ReconcilesLegacyPendingInvitations(t *testing.T) {
	ctx, pool := openOrganizationsMigrationTestPool(t, "organizations_remediation_from_000002")
	migrateDirectory(t, ctx, pool, migrationFixture(t, "000001_initial_schema.sql", "000002_admin_backend_foundation.sql"))

	inviterID := insertOrganizationsTestUser(t, ctx, pool, "inviter@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Remediation Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "owner")

	var olderID, newerID, expiredID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id, created_at)
		VALUES ($1, 'duplicate@example.com', 'member', 'older-token', $2, NOW() - INTERVAL '2 hours')
		RETURNING id
	`, organizationID, inviterID).Scan(&olderID); err != nil {
		t.Fatalf("seed older invitation: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id, created_at)
		VALUES ($1, 'duplicate@example.com', 'member', 'newer-token', $2, NOW() - INTERVAL '1 hour')
		RETURNING id
	`, organizationID, inviterID).Scan(&newerID); err != nil {
		t.Fatalf("seed newer invitation: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE invitations
		SET created_at = NOW() - INTERVAL '1 hour'
		WHERE id IN ($1, $2)
	`, olderID, newerID); err != nil {
		t.Fatalf("align duplicate invitation timestamps: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id, expires_at)
		VALUES ($1, 'expired@example.com', 'member', 'expired-token', $2, NOW() - INTERVAL '1 minute')
		RETURNING id
	`, organizationID, inviterID).Scan(&expiredID); err != nil {
		t.Fatalf("seed expired invitation: %v", err)
	}

	if err := database.Migrate(ctx, pool, productionMigrationsDirectory(t)); err != nil {
		t.Fatalf("migrate production 000003 through 000005: %v", err)
	}

	var survivorID string
	if err := pool.QueryRow(ctx, `SELECT id FROM invitations WHERE id IN ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 1`, olderID, newerID).Scan(&survivorID); err != nil {
		t.Fatalf("load deterministic duplicate survivor: %v", err)
	}
	assertInvitationStatus(t, ctx, pool, survivorID, "pending")
	if survivorID == olderID {
		assertInvitationStatus(t, ctx, pool, newerID, "cancelled")
	} else {
		assertInvitationStatus(t, ctx, pool, olderID, "cancelled")
	}
	assertInvitationStatus(t, ctx, pool, expiredID, "expired")

	if _, err := pool.Exec(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id)
		VALUES ($1, 'expired@example.com', 'member', 'replacement-token', $2)
	`, organizationID, inviterID); err != nil {
		t.Fatalf("create invitation after expiry reconciliation: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id)
		VALUES ($1, 'duplicate@example.com', 'member', 'duplicate-token', $2)
	`, organizationID, inviterID); err == nil {
		t.Fatal("expected partial unique index to reject a second active invitation")
	}
	assertInvitationIndex(t, ctx, pool)
	assertRecordedMigrations(t, ctx, pool, []string{
		"000001_initial_schema.sql",
		"000002_admin_backend_foundation.sql",
		"000003_admin_remediation.sql",
		"000004_admin_remediation_safety.sql",
		"000005_admin_remediation_v2_fix_forward.sql",
		"000006_refresh_sessions.sql",
		"000007_ws_tickets.sql",
		"000008_sync_patch_idempotency.sql",
	})
	migrateDirectory(t, ctx, pool, productionMigrationsDirectory(t))
	assertRecordedMigrations(t, ctx, pool, []string{
		"000001_initial_schema.sql",
		"000002_admin_backend_foundation.sql",
		"000003_admin_remediation.sql",
		"000004_admin_remediation_safety.sql",
		"000005_admin_remediation_v2_fix_forward.sql",
		"000006_refresh_sessions.sql",
		"000007_ws_tickets.sql",
		"000008_sync_patch_idempotency.sql",
	})
}

func TestRecorded000003FixForwardExpiresPendingInvitation(t *testing.T) {
	ctx, pool := openOrganizationsMigrationTestPool(t, "organizations_remediation_recorded_000003")
	historical := historicalMigrationFixture(t)
	migrateDirectory(t, ctx, pool, historical)

	var appliedBefore0003, appliedBefore0004 time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE filename = '000003_admin_remediation.sql'`).Scan(&appliedBefore0003); err != nil {
		t.Fatalf("load recorded historical 000003: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE filename = '000004_admin_remediation_safety.sql'`).Scan(&appliedBefore0004); err != nil {
		t.Fatalf("load recorded historical 000004: %v", err)
	}

	inviterID := insertOrganizationsTestUser(t, ctx, pool, "recorded-inviter@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Recorded History Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, inviterID, "owner")
	var expiredID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id, expires_at)
		VALUES ($1, 'recorded-expired@example.com', 'member', 'recorded-expired-token', $2, NOW() - INTERVAL '1 minute')
		RETURNING id
	`, organizationID, inviterID).Scan(&expiredID); err != nil {
		t.Fatalf("seed expired pending invitation after old 000003: %v", err)
	}

	migrateDirectory(t, ctx, pool, productionMigrationsDirectory(t))
	assertInvitationStatus(t, ctx, pool, expiredID, "expired")
	assertInvitationIndex(t, ctx, pool)
	assertRecordedMigrations(t, ctx, pool, []string{
		"000001_initial_schema.sql",
		"000002_admin_backend_foundation.sql",
		"000003_admin_remediation.sql",
		"000004_admin_remediation_safety.sql",
		"000005_admin_remediation_v2_fix_forward.sql",
		"000006_refresh_sessions.sql",
		"000007_ws_tickets.sql",
		"000008_sync_patch_idempotency.sql",
	})
	var appliedAfter0003, appliedAfter0004 time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE filename = '000003_admin_remediation.sql'`).Scan(&appliedAfter0003); err != nil {
		t.Fatalf("load 000003 after fix-forward: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE filename = '000004_admin_remediation_safety.sql'`).Scan(&appliedAfter0004); err != nil {
		t.Fatalf("load 000004 after fix-forward: %v", err)
	}
	if !appliedAfter0003.Equal(appliedBefore0003) {
		t.Fatalf("recorded 000003 was reapplied: before=%s after=%s", appliedBefore0003, appliedAfter0003)
	}
	if !appliedAfter0004.Equal(appliedBefore0004) {
		t.Fatalf("recorded 000004 was reapplied: before=%s after=%s", appliedBefore0004, appliedAfter0004)
	}
	migrateDirectory(t, ctx, pool, productionMigrationsDirectory(t))
	assertInvitationStatus(t, ctx, pool, expiredID, "expired")
}

func TestInvitationSafetyScenarios(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_remediation_invites")
	service := NewService(pool)
	adminID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Invitation Safety Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	invitation, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "active@example.com", Role: "member"})
	if err != nil {
		t.Fatalf("create active invitation: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, invitation.ID); err != nil {
		t.Fatalf("expire invitation: %v", err)
	}

	invitations, err := service.ListInvitations(ctx, adminID, organizationID)
	if err != nil {
		t.Fatalf("list invitations: %v", err)
	}
	if len(invitations) != 0 {
		t.Fatalf("expired invitations were listed: %#v", invitations)
	}

	for _, tc := range []struct {
		name  string
		input CreateInvitationInput
		want  string
	}{
		{name: "invalid email", input: CreateInvitationInput{Email: "not-an-email", Role: "member"}, want: "invalid_invitation_email"},
		{name: "existing member", input: CreateInvitationInput{Email: "member@example.com", Role: "member"}, want: "invitation_member_exists"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := service.CreateInvitation(ctx, adminID, organizationID, tc.input)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}

	if _, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "pending@example.com", Role: "member"}); err != nil {
		t.Fatalf("create first pending invitation: %v", err)
	}
	_, err = service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "PENDING@example.com", Role: "member"})
	if err == nil || err.Error() != "invitation_pending_exists" {
		t.Fatalf("duplicate error = %v, want invitation_pending_exists", err)
	}
}

func TestOwnerOnlyPromotionAndConcurrentOwnerTransitions(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_remediation_owners")
	service := NewService(pool)
	ownerOneID := insertOrganizationsTestUser(t, ctx, pool, "owner-one@example.com")
	ownerTwoID := insertOrganizationsTestUser(t, ctx, pool, "owner-two@example.com")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Owner Safety Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerOneID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerTwoID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	role := "owner"
	if _, err := service.PatchMember(ctx, adminID, organizationID, PatchMemberInput{UserID: memberID, Role: &role}); err != ErrForbidden {
		t.Fatalf("admin promotion error = %v, want %v", err, ErrForbidden)
	}
	if _, err := service.PatchMember(ctx, ownerOneID, organizationID, PatchMemberInput{UserID: memberID, Role: &role}); err != nil {
		t.Fatalf("owner promotion: %v", err)
	}
	memberRole := "member"
	if _, err := service.PatchMember(ctx, ownerOneID, organizationID, PatchMemberInput{UserID: memberID, Role: &memberRole}); err != nil {
		t.Fatalf("restore promoted member role: %v", err)
	}

	adminRole := "admin"
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, patch := range []struct {
		requester string
		input     PatchMemberInput
	}{
		{requester: ownerOneID, input: PatchMemberInput{UserID: ownerOneID, Role: &adminRole}},
		{requester: ownerTwoID, input: PatchMemberInput{UserID: ownerTwoID, Remove: true}},
	} {
		patch := patch
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := service.PatchMember(ctx, patch.requester, organizationID, patch.input)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	rejections := 0
	for err := range errs {
		if err != nil {
			rejections++
		}
	}
	if rejections == 0 {
		t.Fatal("concurrent owner transitions had no rejection")
	}
	var owners int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND role = 'owner'`, organizationID).Scan(&owners); err != nil {
		t.Fatalf("count remaining owners: %v", err)
	}
	if owners < 1 {
		t.Fatalf("owner count = %d, want at least 1", owners)
	}
}

func openOrganizationsMigrationTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL migration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("ORGANIZATIONS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set ORGANIZATIONS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
	}

	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open admin pool: %v", err)
	}
	if err := adminPool.Ping(ctx); err != nil {
		adminPool.Close()
		t.Fatalf("ping PostgreSQL: %v", err)
	}

	schemaName := fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schemaName)); err != nil {
		adminPool.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := adminPool.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schemaName)); err != nil {
			t.Errorf("drop schema: %v", err)
		}
		adminPool.Close()
	})

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database URL: %v", err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open test pool: %v", err)
	}
	t.Cleanup(pool.Close)

	return ctx, pool
}

func migrateDirectory(t *testing.T, ctx context.Context, pool *pgxpool.Pool, migrationsDir string) {
	t.Helper()
	if err := database.Migrate(ctx, pool, migrationsDir); err != nil {
		t.Fatalf("migrate %s: %v", migrationsDir, err)
	}
}

func productionMigrationsDirectory(t *testing.T) string {
	t.Helper()
	return filepath.Clean(filepath.Join("..", "..", "migrations"))
}

func migrationFixture(t *testing.T, filenames ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, filename := range filenames {
		contents, err := os.ReadFile(filepath.Join(productionMigrationsDirectory(t), filename))
		if err != nil {
			t.Fatalf("read production migration %s: %v", filename, err)
		}
		if err := os.WriteFile(filepath.Join(dir, filename), contents, 0o600); err != nil {
			t.Fatalf("write fixture migration %s: %v", filename, err)
		}
	}
	return dir
}

func historicalMigrationFixture(t *testing.T) string {
	t.Helper()
	dir := migrationFixture(t, "000001_initial_schema.sql", "000002_admin_backend_foundation.sql")
	for filename, contents := range map[string]string{
		"000003_admin_remediation.sql": `-- Prevent semantic duplicates when a client retries a creation after an
-- ambiguous transport outcome. API idempotency keys are retained client-side;
-- these constraints are the database backstop.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending_email_per_organization
    ON invitations (organization_id, lower(email))
    WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_unique_name_type_per_organization
    ON workspaces (organization_id, name, type);
`,
		"000004_admin_remediation_safety.sql": `-- 000003 may already be recorded in shared environments. Reconcile legacy
-- pending rows before relying on its partial unique invitation index.
UPDATE invitations
SET status = 'expired',
    updated_at = NOW()
WHERE status = 'pending'
  AND expires_at IS NOT NULL
  AND expires_at <= NOW();

WITH ranked_pending_invitations AS (
    SELECT id,
        ROW_NUMBER() OVER (
            PARTITION BY organization_id, lower(email)
            ORDER BY created_at DESC, id DESC
        ) AS row_number
    FROM invitations
    WHERE status = 'pending'
      AND (expires_at IS NULL OR expires_at > NOW())
)
UPDATE invitations
SET status = 'cancelled',
    updated_at = NOW()
FROM ranked_pending_invitations ranked
WHERE invitations.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending_email_per_organization
    ON invitations (organization_id, lower(email))
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    response_status INTEGER,
    safe_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (principal_id, method, route, key)
);

ALTER TABLE idempotency_records
    ADD CONSTRAINT idempotency_records_key_not_blank CHECK (length(btrim(key)) > 0 AND length(key) <= 255),
    ADD CONSTRAINT idempotency_records_terminal_response CHECK (
        (status = 'completed' AND response_status = 201 AND safe_response IS NOT NULL AND completed_at IS NOT NULL)
        OR
        (status <> 'completed' AND response_status IS NULL AND safe_response IS NULL AND completed_at IS NULL)
    );

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
    ON idempotency_records (expires_at);
`,
	} {
		if err := os.WriteFile(filepath.Join(dir, filename), []byte(contents), 0o600); err != nil {
			t.Fatalf("write historical migration %s: %v", filename, err)
		}
	}
	return dir
}

func assertInvitationIndex(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('invitations_one_pending_email_per_organization') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatalf("check invitation unique index: %v", err)
	}
	if !exists {
		t.Fatal("invitation unique index does not exist")
	}
}

func assertRecordedMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool, want []string) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT filename FROM schema_migrations ORDER BY filename`)
	if err != nil {
		t.Fatalf("query schema_migrations: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var filename string
		if err := rows.Scan(&filename); err != nil {
			t.Fatalf("scan migration filename: %v", err)
		}
		got = append(got, filename)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate schema_migrations: %v", err)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("recorded migrations = %v, want %v", got, want)
	}
}

func assertInvitationStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, invitationID, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(ctx, `SELECT status FROM invitations WHERE id = $1`, invitationID).Scan(&got); err != nil {
		t.Fatalf("load invitation status: %v", err)
	}
	if got != want {
		t.Fatalf("invitation %s status = %q, want %q", invitationID, got, want)
	}
}

package organizations

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCreateOrganizationBootstrapsCreatorAsOwner(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_test")
	service := NewService(pool, activity.NewService(pool))
	userID := insertOrganizationsTestUser(t, ctx, pool, "creator@example.com")

	membership, err := service.CreateOrganization(ctx, userID, CreateOrganizationInput{Name: "OdA Core"})
	if err != nil {
		t.Fatalf("create organization: %v", err)
	}
	if membership.OrganizationName != "OdA Core" {
		t.Fatalf("organization name = %q, want %q", membership.OrganizationName, "OdA Core")
	}
	if membership.Role != "owner" {
		t.Fatalf("role = %q, want owner", membership.Role)
	}

	var storedRole string
	err = pool.QueryRow(ctx, `
		SELECT role
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, membership.OrganizationID, userID).Scan(&storedRole)
	if err != nil {
		t.Fatalf("query stored role: %v", err)
	}
	if storedRole != "owner" {
		t.Fatalf("stored role = %q, want owner", storedRole)
	}
}

func TestPatchMemberRejectsRemovingLastOwner(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "owner@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Only Owner Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")

	_, err := service.PatchMember(ctx, ownerID, organizationID, PatchMemberInput{
		UserID: ownerID,
		Remove: true,
	})
	if err == nil {
		t.Fatal("expected last-owner removal to fail")
	}
	if err != ErrLastOwner {
		t.Fatalf("err = %v, want %v", err, ErrLastOwner)
	}

	memberRole := loadOrganizationsTestMemberRole(t, ctx, pool, organizationID, ownerID)
	if memberRole != "owner" {
		t.Fatalf("stored role = %q, want owner", memberRole)
	}
}

func TestCreateInvitationSetsExpiryAndInviterContext(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invite_expiry_test")
	service := NewService(pool, activity.NewService(pool))
	adminID := insertOrganizationsTestUser(t, ctx, pool, "admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Acme Corp")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	before := time.Now().UTC()
	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "invitee@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	after := time.Now().UTC()

	wantMin := before.Add(invitationTTL).Add(-time.Minute)
	wantMax := after.Add(invitationTTL).Add(time.Minute)
	if created.ExpiresAt.Before(wantMin) || created.ExpiresAt.After(wantMax) {
		t.Fatalf("ExpiresAt = %v, want within [%v, %v]", created.ExpiresAt, wantMin, wantMax)
	}
	if created.OrganizationName != "Acme Corp" {
		t.Fatalf("OrganizationName = %q, want %q", created.OrganizationName, "Acme Corp")
	}
	if created.InviterEmail != "admin@example.com" {
		t.Fatalf("InviterEmail = %q, want %q", created.InviterEmail, "admin@example.com")
	}
	if created.InviterName != "" {
		t.Fatalf("InviterName = %q, want empty for NULL users.name", created.InviterName)
	}

	var storedExpiresAt time.Time
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM invitations WHERE id = $1`, created.Invitation.ID).Scan(&storedExpiresAt); err != nil {
		t.Fatalf("query stored expires_at: %v", err)
	}
	if storedExpiresAt.Before(wantMin) || storedExpiresAt.After(wantMax) {
		t.Fatalf("stored expires_at = %v, want within [%v, %v]", storedExpiresAt, wantMin, wantMax)
	}
}

func TestCreateInvitationInviterNamePopulatedWhenPresent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_invite_expiry_test")
	service := NewService(pool, activity.NewService(pool))
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Beta Org")

	var adminID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, name)
		VALUES ($1, $2, $3)
		RETURNING id
	`, "named-admin@example.com", "hash", "Ada Lovelace").Scan(&adminID); err != nil {
		t.Fatalf("insert named user: %v", err)
	}
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{
		Email: "invitee2@example.com",
		Role:  "member",
	})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if created.InviterName != "Ada Lovelace" {
		t.Fatalf("InviterName = %q, want %q", created.InviterName, "Ada Lovelace")
	}
}

// Phase 3: Organizations Wiring — RED: CreateOrganizationTx (invoked via
// CreateOrganization's begin/commit wrapper) records a KindOrganizationCreated
// event scoped to the newly created organization, atomic with the commit.
func TestCreateOrganizationRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_activity_create_test")
	service := NewService(pool, activity.NewService(pool))
	userID := insertOrganizationsTestUser(t, ctx, pool, "creator-activity@example.com")

	membership, err := service.CreateOrganization(ctx, userID, CreateOrganizationInput{Name: "Activity Org"})
	if err != nil {
		t.Fatalf("create organization: %v", err)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, membership.OrganizationID, userID, activity.KindOrganizationCreated, "organization", membership.OrganizationID)
}

// Phase 3: Organizations Wiring — RED: PatchMember's role-change branch
// records a KindOrganizationMemberRoleChanged event.
func TestPatchMemberRoleChangeRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_activity_role_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "role-activity-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "role-activity-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Activity Role Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	adminRole := "admin"
	if _, err := service.PatchMember(ctx, ownerID, organizationID, PatchMemberInput{UserID: memberID, Role: &adminRole}); err != nil {
		t.Fatalf("patch member role: %v", err)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationMemberRoleChanged, "organization_member", memberID)
}

// Phase 3: Organizations Wiring — RED: PatchMember's remove branch records a
// KindOrganizationMemberRemoved event.
func TestPatchMemberRemovalRecordsActivityEvent(t *testing.T) {
	t.Parallel()

	ctx, pool := openOrganizationsTestPool(t, "organizations_activity_remove_test")
	service := NewService(pool, activity.NewService(pool))
	ownerID := insertOrganizationsTestUser(t, ctx, pool, "remove-activity-owner@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "remove-activity-member@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Activity Remove Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, ownerID, "owner")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	if _, err := service.PatchMember(ctx, ownerID, organizationID, PatchMemberInput{UserID: memberID, Remove: true}); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	assertOrganizationsTestActivityEvent(t, ctx, pool, organizationID, ownerID, activity.KindOrganizationMemberRemoved, "organization_member", memberID)
}

func openOrganizationsTestPool(t *testing.T, prefix string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration-style test in short mode")
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

func insertOrganizationsTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func insertOrganizationsTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
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

func insertOrganizationsTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func loadOrganizationsTestMemberRole(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID string) string {
	t.Helper()

	var role string
	err := pool.QueryRow(ctx, `
		SELECT role
		FROM organization_members
		WHERE organization_id = $1 AND user_id = $2
	`, organizationID, userID).Scan(&role)
	if err != nil {
		t.Fatalf("query organization member: %v", err)
	}

	return role
}

// assertOrganizationsTestActivityEvent asserts exactly one activity_events
// row exists matching the given organization/actor/kind/target, per the
// design's Call-Site Wiring table for organizations/service.go.
func assertOrganizationsTestActivityEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, actorUserID string, kind activity.Kind, targetType, targetID string) {
	t.Helper()

	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM activity_events
		WHERE organization_id = $1 AND actor_user_id = $2 AND kind = $3 AND target_type = $4 AND target_id = $5
	`, organizationID, actorUserID, string(kind), targetType, targetID).Scan(&count)
	if err != nil {
		t.Fatalf("count activity events: %v", err)
	}
	if count != 1 {
		t.Fatalf("activity event count = %d, want 1 (organizationId=%s actorUserId=%s kind=%s targetType=%s targetId=%s)",
			count, organizationID, actorUserID, kind, targetType, targetID)
	}
}

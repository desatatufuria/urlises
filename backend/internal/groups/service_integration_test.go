package groups

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

func TestAddMemberRejectsUserOutsideOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	outsiderID := insertGroupsTestUser(t, ctx, pool, "outsider@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	_, err := service.AddMember(ctx, adminID, groupID, AddGroupMemberInput{UserID: outsiderID})
	if err == nil {
		t.Fatal("expected outsider group membership to be rejected")
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	var memberCount int
	err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM group_members WHERE group_id = $1`, groupID).Scan(&memberCount)
	if err != nil {
		t.Fatalf("count group members: %v", err)
	}
	if memberCount != 0 {
		t.Fatalf("memberCount = %d, want 0", memberCount)
	}
}

func TestListMembersReturnsGroupMembershipForAdminsOnly(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	firstMemberID := insertGroupsTestUser(t, ctx, pool, "a-member@example.com")
	secondMemberID := insertGroupsTestUser(t, ctx, pool, "z-member@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertGroupsTestMember(t, ctx, pool, organizationID, firstMemberID, "member")
	insertGroupsTestMember(t, ctx, pool, organizationID, secondMemberID, "member")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")
	insertGroupsTestGroupMember(t, ctx, pool, groupID, secondMemberID)
	insertGroupsTestGroupMember(t, ctx, pool, groupID, firstMemberID)

	members, err := service.ListMembers(ctx, adminID, groupID)
	if err != nil {
		t.Fatalf("list group members: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("member count = %d, want 2", len(members))
	}
	if members[0].UserID != firstMemberID || members[1].UserID != secondMemberID {
		t.Fatalf("member order = [%s %s], want [%s %s]", members[0].UserID, members[1].UserID, firstMemberID, secondMemberID)
	}
}

func TestListMembersRejectsNonAdmins(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "admin@example.com")
	memberID := insertGroupsTestUser(t, ctx, pool, "member@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "Groups Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertGroupsTestMember(t, ctx, pool, organizationID, memberID, "member")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")
	insertGroupsTestGroupMember(t, ctx, pool, groupID, memberID)

	members, err := service.ListMembers(ctx, memberID, groupID)
	if err == nil {
		t.Fatalf("expected non-admin list members to fail, got %#v", members)
	}
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

// Slice 2b — RED: choke point 10 (the duplicate requireOrganizationAdmin in
// this package). Group admin operations reject on a soft-deleted
// organization with ErrForbidden. Create is the representative call site;
// Update, Delete, AddMember and RemoveMember all route through the same gate
// function.
func TestCreateGroupRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "cp10-admin@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "CP10 Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	softDeleteGroupsTestOrganization(t, ctx, pool, organizationID)

	_, err := service.Create(ctx, adminID, organizationID, CreateGroupInput{Name: "devops"})
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}
}

// Slice 2b — RED: choke point 11. requireOrganizationMembership rejects
// adding a group member whose organization is soft-deleted, even though the
// group itself and the target user's membership row both still exist.
func TestAddMemberRejectsSoftDeletedOrganization(t *testing.T) {
	t.Parallel()

	ctx, pool := openGroupsTestPool(t)
	service := NewService(pool, activity.NewService(pool))
	adminID := insertGroupsTestUser(t, ctx, pool, "cp11-admin@example.com")
	memberID := insertGroupsTestUser(t, ctx, pool, "cp11-member@example.com")
	organizationID := insertGroupsTestOrganization(t, ctx, pool, "CP11 Org")
	insertGroupsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertGroupsTestMember(t, ctx, pool, organizationID, memberID, "member")
	groupID := insertGroupsTestGroup(t, ctx, pool, organizationID, "devops")

	// requireOrganizationAdmin (CP10) is checked before requireOrganizationMembership
	// (CP11) inside AddMemberTx, so CP11 can only be observed once CP10 is
	// satisfied. Soft-delete the organization only after asserting CP10
	// would already have blocked a non-live org — here we verify CP11
	// directly via the unexported function, package-internal, as defense in
	// depth behind CP10.
	softDeleteGroupsTestOrganization(t, ctx, pool, organizationID)

	err := requireOrganizationMembership(ctx, pool, organizationID, memberID)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want %v", err, ErrForbidden)
	}

	// End-to-end: AddMember (gated by CP10 first) also fails closed.
	_, err = service.AddMember(ctx, adminID, groupID, AddGroupMemberInput{UserID: memberID})
	if err != ErrForbidden {
		t.Fatalf("AddMember err = %v, want %v", err, ErrForbidden)
	}
}

// softDeleteGroupsTestOrganization stamps deleted_at directly via SQL so
// choke-point tests can construct an already-trashed organization fixture.
func softDeleteGroupsTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `UPDATE organizations SET deleted_at = NOW() WHERE id = $1`, organizationID); err != nil {
		t.Fatalf("soft delete organization fixture: %v", err)
	}
}

func openGroupsTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping PostgreSQL integration test in short mode")
	}

	databaseURL := strings.TrimSpace(os.Getenv("GROUPS_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("set GROUPS_TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL tests")
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

	schemaName := fmt.Sprintf("groups_test_%d", time.Now().UnixNano())
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

func insertGroupsTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
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

func insertGroupsTestOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
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

func insertGroupsTestMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, userID, role string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (organization_id, user_id, role)
		VALUES ($1, $2, $3)
	`, organizationID, userID, role); err != nil {
		t.Fatalf("insert organization member: %v", err)
	}
}

func insertGroupsTestGroup(t *testing.T, ctx context.Context, pool *pgxpool.Pool, organizationID, name string) string {
	t.Helper()

	var groupID string
	err := pool.QueryRow(ctx, `
		INSERT INTO groups (organization_id, name)
		VALUES ($1, $2)
		RETURNING id
	`, organizationID, name).Scan(&groupID)
	if err != nil {
		t.Fatalf("insert group: %v", err)
	}

	return groupID
}

func insertGroupsTestGroupMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, groupID, userID string) {
	t.Helper()

	if _, err := pool.Exec(ctx, `
		INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2)
	`, groupID, userID); err != nil {
		t.Fatalf("insert group member: %v", err)
	}
}

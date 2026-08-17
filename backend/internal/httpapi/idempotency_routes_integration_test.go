package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/furia/shared-bookmark-sync/backend/internal/groups"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/furia/shared-bookmark-sync/backend/internal/organizations"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIdempotencyRoutesIsolateInvitationTargets(t *testing.T) {
	ctx, pool := openRoutesPool(t)
	userID := seedRouteUser(t, ctx, pool, "admin@example.com")
	orgA := seedRouteOrganization(t, ctx, pool, userID, "Org A")
	orgB := seedRouteOrganization(t, ctx, pool, userID, "Org B")
	mux := http.NewServeMux()
	authn := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID})))
		})
	}
	executor := httpapi.NewIdempotencyExecutor(pool)
	organizations.RegisterRoutes(mux, authn, organizations.NewService(pool), executor)

	body := `{"email":"invitee@example.com","role":"member"}`
	first := routeRequest(mux, http.MethodPost, "/organizations/"+orgA+"/invitations", body, "shared-key")
	second := routeRequest(mux, http.MethodPost, "/organizations/"+orgB+"/invitations", body, "shared-key")
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf("statuses = %d, %d", first.Code, second.Code)
	}
	var firstBody, secondBody map[string]any
	_ = json.Unmarshal(first.Body.Bytes(), &firstBody)
	_ = json.Unmarshal(second.Body.Bytes(), &secondBody)
	if firstBody["organizationId"] == secondBody["organizationId"] {
		t.Fatalf("second target replayed first response: %s", second.Body.String())
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM invitations WHERE organization_id = $1`, orgB).Scan(&count); err != nil || count != 1 {
		t.Fatalf("target B invitation count=%d err=%v", count, err)
	}
}

func TestIdempotencyRoutesCreateAndReplayAllFive(t *testing.T) {
	ctx, pool := openRoutesPool(t)
	userID := seedRouteUser(t, ctx, pool, "five-routes-admin@example.com")
	memberID := seedRouteUser(t, ctx, pool, "five-routes-member@example.com")
	baseOrgID := seedRouteOrganization(t, ctx, pool, userID, "Five Routes Base")
	if _, err := pool.Exec(ctx, `INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'member')`, baseOrgID, memberID); err != nil {
		t.Fatal(err)
	}
	mux := routesMux(userID, pool)

	organization := assertRouteReplay(t, mux, "/organizations", `{"name":"Idempotent Organization"}`, "organization-key")
	organizationID := stringField(t, organization, "organizationId")
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations WHERE id = $1`, organizationID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("organization count=%d err=%v", count, err)
	}

	invitation := assertRouteReplay(t, mux, "/organizations/"+baseOrgID+"/invitations", `{"email":"five-invite@example.com","role":"member"}`, "invitation-key")
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM invitations WHERE id = $1`, stringField(t, invitation, "id")).Scan(&count); err != nil || count != 1 {
		t.Fatalf("invitation count=%d err=%v", count, err)
	}
	conflict := routeRequest(mux, http.MethodPost, "/organizations/"+baseOrgID+"/invitations", `{"email":"different@example.com","role":"member"}`, "invitation-key")
	if conflict.Code != http.StatusConflict {
		t.Fatalf("fingerprint mismatch status=%d body=%s", conflict.Code, conflict.Body.String())
	}

	group := assertRouteReplay(t, mux, "/organizations/"+baseOrgID+"/groups", `{"name":"Idempotent Group"}`, "group-key")
	groupID := stringField(t, group, "id")
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM groups WHERE id = $1`, groupID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("group count=%d err=%v", count, err)
	}

	groupMember := assertRouteReplay(t, mux, "/groups/"+groupID+"/members", fmt.Sprintf(`{"userId":%q}`, memberID), "group-member-key")
	if stringField(t, groupMember, "userId") != memberID {
		t.Fatalf("group member = %#v", groupMember)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM group_members WHERE group_id = $1 AND user_id = $2`, groupID, memberID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("group member count=%d err=%v", count, err)
	}

	workspace := assertRouteReplay(t, mux, "/organizations/"+baseOrgID+"/workspaces", `{"name":"Idempotent Workspace","type":"team"}`, "workspace-key")
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM workspaces WHERE id = $1`, stringField(t, workspace, "workspaceId")).Scan(&count); err != nil || count != 1 {
		t.Fatalf("workspace count=%d err=%v", count, err)
	}
}

func TestIdempotencyRoutesAllowAuthenticatedMemberToCreateOrganization(t *testing.T) {
	ctx, pool := openRoutesPool(t)
	ownerID := seedRouteUser(t, ctx, pool, "member-create-owner@example.com")
	memberID := seedRouteUser(t, ctx, pool, "member-create-user@example.com")
	baseOrgID := seedRouteOrganization(t, ctx, pool, ownerID, "Member Create Base")
	if _, err := pool.Exec(ctx, `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')`, baseOrgID, memberID); err != nil {
		t.Fatal(err)
	}

	response := routeRequest(routesMux(memberID, pool), http.MethodPost, "/organizations", `{"name":"Member Created Organization"}`, "member-create-key")
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}

	var membership map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &membership); err != nil {
		t.Fatal(err)
	}
	organizationID := stringField(t, membership, "organizationId")
	if membership["role"] != "owner" {
		t.Fatalf("created membership role=%v, want owner", membership["role"])
	}
	var storedRole string
	if err := pool.QueryRow(ctx, `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`, organizationID, memberID).Scan(&storedRole); err != nil {
		t.Fatal(err)
	}
	if storedRole != "owner" {
		t.Fatalf("stored role=%q, want owner", storedRole)
	}
}

func TestIdempotencyRoutesDenyRevokedReplayWithoutStoredDTO(t *testing.T) {
	ctx, pool := openRoutesPool(t)
	userID := seedRouteUser(t, ctx, pool, "revoked-admin@example.com")
	organizationID := seedRouteOrganization(t, ctx, pool, userID, "Revoked Replay")
	mux := routesMux(userID, pool)
	path := "/organizations/" + organizationID + "/invitations"
	body := `{"email":"stored-dto@example.com","role":"member"}`
	if response := routeRequest(mux, http.MethodPost, path, body, "revoked-key"); response.Code != http.StatusCreated {
		t.Fatalf("initial status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	replay := routeRequest(mux, http.MethodPost, path, body, "revoked-key")
	if replay.Code != http.StatusForbidden {
		t.Fatalf("revoked replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	if strings.Contains(replay.Body.String(), "stored-dto@example.com") {
		t.Fatalf("revoked replay exposed stored dto: %s", replay.Body.String())
	}
}

func routesMux(userID string, pool *pgxpool.Pool) *http.ServeMux {
	mux := http.NewServeMux()
	authn := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID})))
		})
	}
	executor := httpapi.NewIdempotencyExecutor(pool)
	organizations.RegisterRoutes(mux, authn, organizations.NewService(pool), executor)
	groups.RegisterRoutes(mux, authn, groups.NewService(pool), executor)
	workspaces.RegisterRoutes(mux, authn, workspaces.NewService(pool, nil), executor)
	return mux
}

func assertRouteReplay(t *testing.T, mux *http.ServeMux, path, body, key string) map[string]any {
	t.Helper()
	first := routeRequest(mux, http.MethodPost, path, body, key)
	second := routeRequest(mux, http.MethodPost, path, body, key)
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf("%s statuses=%d,%d first=%s second=%s", path, first.Code, second.Code, first.Body.String(), second.Body.String())
	}
	var firstBody, secondBody map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Body.Bytes(), &secondBody); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(firstBody) != fmt.Sprint(secondBody) {
		t.Fatalf("%s replay differs: first=%v second=%v", path, firstBody, secondBody)
	}
	return firstBody
}

func stringField(t *testing.T, body map[string]any, field string) string {
	t.Helper()
	value, ok := body[field].(string)
	if !ok || value == "" {
		t.Fatalf("missing %s in %#v", field, body)
	}
	return value
}

func routeRequest(mux *http.ServeMux, method, path, body, key string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Idempotency-Key", key)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func openRoutesPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("HTTPAPI_TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Fatal("HTTPAPI_TEST_DATABASE_URL or DATABASE_URL is required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("idempotency_routes_%d", time.Now().UnixNano())
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

func seedRouteUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `INSERT INTO users (email,password_hash) VALUES ($1,'hash') RETURNING id`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
func seedRouteOrganization(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID, name string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'owner')`, id, userID); err != nil {
		t.Fatal(err)
	}
	return id
}

var _ = groups.NewService
var _ = workspaces.NewService

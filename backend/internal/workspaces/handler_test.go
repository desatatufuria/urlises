package workspaces

import (
	"context"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type workspacesRouteStub struct {
	requester         string
	snapshot          WorkspaceAccessSnapshot
	err               error
	restoreErr        error
	deletedWorkspaces []DeletedWorkspace
	listDeletedErr    error
}

func TestCreationRouteRequiresIdempotencyKey(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, workspacePrincipal, &workspacesRouteStub{}, httpapi.NewIdempotencyExecutor(nil))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/organizations/org-1/workspaces", strings.NewReader(`{"name":"Workspace","type":"team"}`)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", w.Code)
	}
}

func (s *workspacesRouteStub) ListByOrganization(context.Context, string, string) ([]WorkspaceAccess, error) {
	return nil, nil
}
func (s *workspacesRouteStub) Create(context.Context, string, string, CreateWorkspaceInput) (WorkspaceAccess, error) {
	return WorkspaceAccess{}, nil
}
func (s *workspacesRouteStub) GetAccessibleWorkspace(context.Context, string, string) (WorkspaceAccess, error) {
	return WorkspaceAccess{}, nil
}
func (s *workspacesRouteStub) GetTree(context.Context, string, string) (TreeResponse, error) {
	return TreeResponse{}, nil
}
func (s *workspacesRouteStub) GrantUserAccess(context.Context, string, string, string, UpdateUserAccessInput) (UserAccessGrant, error) {
	return UserAccessGrant{}, nil
}
func (s *workspacesRouteStub) RevokeUserAccess(context.Context, string, string, string) error {
	return nil
}
func (s *workspacesRouteStub) GrantGroupAccess(context.Context, string, string, string, UpdateGroupAccessInput) (GroupAccessGrant, error) {
	return GroupAccessGrant{}, nil
}
func (s *workspacesRouteStub) RevokeGroupAccess(context.Context, string, string, string) error {
	return nil
}
func (s *workspacesRouteStub) GetAccessSnapshot(_ context.Context, requester, _ string) (WorkspaceAccessSnapshot, error) {
	s.requester = requester
	return s.snapshot, s.err
}
func (s *workspacesRouteStub) Delete(_ context.Context, requester, _ string) error {
	s.requester = requester
	return s.err
}
func (s *workspacesRouteStub) Restore(_ context.Context, requester, _ string) error {
	s.requester = requester
	return s.restoreErr
}
func (s *workspacesRouteStub) ListDeleted(_ context.Context, requester string) ([]DeletedWorkspace, error) {
	s.requester = requester
	return s.deletedWorkspaces, s.listDeletedErr
}
func workspacePrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "admin-1"})))
	})
}
func TestWorkspaceAccessReadRouteEnvelopeAndStatuses(t *testing.T) {
	stub := &workspacesRouteStub{snapshot: WorkspaceAccessSnapshot{Workspace: WorkspaceSummary{WorkspaceID: "workspace-1"}}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workspacePrincipal, stub)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/workspaces/workspace-1/access", nil))
	if rr.Code != http.StatusOK || stub.requester != "admin-1" || !strings.Contains(rr.Body.String(), "workspace") {
		t.Fatalf("status=%d requester=%q body=%s", rr.Code, stub.requester, rr.Body.String())
	}
	stub.err = ErrForbidden
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/workspaces/workspace-1/access", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d", rr.Code)
	}
	mux = http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub)
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/workspaces/workspace-1/access", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", rr.Code)
	}
}

// Phase 3 (Slice 3) — RED: DELETE /workspaces/{workspaceId} returns 204 on
// success, 403 on ErrForbidden, and 404 on ErrNotFound.
func TestDeleteWorkspaceRouteStatuses(t *testing.T) {
	stub := &workspacesRouteStub{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workspacePrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/workspaces/workspace-1", nil))
	if rr.Code != http.StatusNoContent || stub.requester != "admin-1" {
		t.Fatalf("status=%d requester=%q", rr.Code, stub.requester)
	}

	stub.err = ErrForbidden
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/workspaces/workspace-1", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d", rr.Code)
	}

	stub.err = ErrNotFound
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodDelete, "/workspaces/workspace-1", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status=%d", rr.Code)
	}
}

// Slice 3a — RED: POST /workspaces/{workspaceId}/restore returns 204 on
// success, 403 on ErrForbidden (non-admin), 404 on ErrNotFound (workspace
// inside a soft-deleted org, or a live workspace, or an unknown id -- all
// three collapse onto the same ErrNotFound per design.md), and 401 when
// unauthenticated -- mirrors TestDeleteWorkspaceRouteStatuses's stub-driven
// style so this runs without a database.
func TestRestoreWorkspaceRouteStatuses(t *testing.T) {
	stub := &workspacesRouteStub{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workspacePrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/restore", nil))
	if rr.Code != http.StatusNoContent || stub.requester != "admin-1" {
		t.Fatalf("status=%d requester=%q", rr.Code, stub.requester)
	}
	if rr.Body.Len() != 0 {
		t.Fatalf("body=%q, want empty", rr.Body.String())
	}

	stub.restoreErr = ErrForbidden
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/restore", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", rr.Code)
	}

	stub.restoreErr = ErrNotFound
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/restore", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", rr.Code)
	}

	mux = http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub)
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/workspaces/workspace-1/restore", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rr.Code)
	}
}

// Slice 3a — RED: GET /workspaces/deleted returns 200 with a
// {"workspaces": [...]} envelope. No 403 case: authorization is inline in
// the query's JOIN (design.md "Trash scoping and route shape" decision), so
// an unauthorized requester gets an empty list, never a 403.
func TestListDeletedWorkspacesRouteEnvelope(t *testing.T) {
	stub := &workspacesRouteStub{deletedWorkspaces: []DeletedWorkspace{{WorkspaceID: "workspace-1", WorkspaceName: "Trashed Workspace"}}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workspacePrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/workspaces/deleted", nil))
	if rr.Code != http.StatusOK || stub.requester != "admin-1" {
		t.Fatalf("status=%d requester=%q", rr.Code, stub.requester)
	}
	if !strings.Contains(rr.Body.String(), "Trashed Workspace") || !strings.Contains(rr.Body.String(), "workspaces") {
		t.Fatalf("unexpected envelope %s", rr.Body.String())
	}
}

// Task 3.13 — RED: GET /workspaces/deleted must NOT be swallowed by the
// GET /workspaces/{workspaceId} pattern already registered on this mux.
// Go 1.22+ ServeMux prefers the more specific literal segment over a
// wildcard regardless of registration order (design.md "Route-precedence
// note"). This proves the literal "deleted" segment wins by observing
// which stub method actually ran: GetAccessibleWorkspace would set
// stub.requester and return an empty WorkspaceAccess with no "workspaces"
// envelope key, while ListDeleted returns the {"workspaces": [...]} shape.
func TestWorkspacesDeletedRoutePrecedenceOverWorkspaceIDPattern(t *testing.T) {
	stub := &workspacesRouteStub{deletedWorkspaces: []DeletedWorkspace{{WorkspaceID: "workspace-precedence", WorkspaceName: "Precedence Workspace"}}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workspacePrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/workspaces/deleted", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200 (literal /workspaces/deleted must win)", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"workspaces"`) {
		t.Fatalf("body=%s, want the ListDeleted envelope shape, not GetAccessibleWorkspace's", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "Precedence Workspace") {
		t.Fatalf("body=%s, want it to contain the ListDeleted fixture data", rr.Body.String())
	}
}

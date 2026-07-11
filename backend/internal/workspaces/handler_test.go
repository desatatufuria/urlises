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
	requester string
	snapshot  WorkspaceAccessSnapshot
	err       error
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

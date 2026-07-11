package groups

import (
	"context"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type groupsRouteStub struct {
	requester string
	members   []GroupMember
	err       error
}

func TestCreationRoutesRequireIdempotencyKey(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, groupPrincipal, &groupsRouteStub{}, httpapi.NewIdempotencyExecutor(nil))
	for _, tc := range []struct{ path, body string }{{"/organizations/org-1/groups", `{"name":"Group"}`}, {"/groups/group-1/members", `{"userId":"user-1"}`}} {
		t.Run(tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body)))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d", w.Code)
			}
		})
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/organizations/org-1/groups/group-1", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d", w.Code)
	}
}

func (s *groupsRouteStub) List(context.Context, string, string) ([]Group, error) { return nil, nil }
func (s *groupsRouteStub) Create(context.Context, string, string, CreateGroupInput) (Group, error) {
	return Group{}, nil
}
func (s *groupsRouteStub) Update(context.Context, string, string, string, UpdateGroupInput) (Group, error) {
	return Group{}, nil
}
func (s *groupsRouteStub) Delete(context.Context, string, string, string) error { return nil }
func (s *groupsRouteStub) AddMember(context.Context, string, string, AddGroupMemberInput) (GroupMember, error) {
	return GroupMember{}, nil
}
func (s *groupsRouteStub) RemoveMember(context.Context, string, string, string) error { return nil }
func (s *groupsRouteStub) ListMembers(_ context.Context, requester, _ string) ([]GroupMember, error) {
	s.requester = requester
	return s.members, s.err
}
func groupPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "admin-1"})))
	})
}
func TestGroupMembersReadRouteEnvelopeAndStatuses(t *testing.T) {
	stub := &groupsRouteStub{members: []GroupMember{{UserID: "user-1", Email: "member@example.com"}}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, groupPrincipal, stub)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/groups/group-1/members", nil))
	if rr.Code != http.StatusOK || stub.requester != "admin-1" || !strings.Contains(rr.Body.String(), "members") {
		t.Fatalf("status=%d requester=%q body=%s", rr.Code, stub.requester, rr.Body.String())
	}
	stub.err = ErrForbidden
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/groups/group-1/members", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d", rr.Code)
	}
	mux = http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub)
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/groups/group-1/members", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", rr.Code)
	}
}

package organizations

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

type organizationsRouteStub struct {
	requester   string
	invitations []PendingInvitation
	err         error
}

func TestCreationRoutesRequireIdempotencyKey(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, organizationPrincipal, &organizationsRouteStub{}, httpapi.NewIdempotencyExecutor(nil))
	for _, tc := range []struct{ path, body string }{{"/organizations", `{"name":"Org"}`}, {"/organizations/org-1/invitations", `{"email":"member@example.com","role":"member"}`}} {
		t.Run(tc.path, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d", w.Code)
			}
		})
	}
	// PATCH is deliberately excluded and remains callable without a key.
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodPatch, "/organizations/org-1/members", strings.NewReader(`{"userId":"member-1","remove":true}`)))
	if w.Code != http.StatusNoContent {
		t.Fatalf("patch status=%d", w.Code)
	}
}

func (s *organizationsRouteStub) ListMemberships(context.Context, string) ([]Membership, error) {
	return nil, nil
}
func (s *organizationsRouteStub) CreateOrganization(context.Context, string, CreateOrganizationInput) (Membership, error) {
	return Membership{}, nil
}
func (s *organizationsRouteStub) ListMembers(context.Context, string, string) ([]OrganizationMember, error) {
	return nil, nil
}
func (s *organizationsRouteStub) PatchMember(context.Context, string, string, PatchMemberInput) (OrganizationMember, error) {
	return OrganizationMember{}, nil
}
func (s *organizationsRouteStub) CreateInvitation(context.Context, string, string, CreateInvitationInput) (Invitation, error) {
	return Invitation{}, nil
}
func (s *organizationsRouteStub) ListInvitations(_ context.Context, requester, _ string) ([]PendingInvitation, error) {
	s.requester = requester
	return s.invitations, s.err
}

func organizationPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "admin-1"})))
	})
}

func TestInvitationReadRouteEnvelopeAuthAndErrors(t *testing.T) {
	stub := &organizationsRouteStub{invitations: []PendingInvitation{{ID: "invite-1", Email: "member@example.com", Status: "pending"}}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, organizationPrincipal, stub)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/organizations/org-1/invitations", nil))
	if recorder.Code != http.StatusOK || stub.requester != "admin-1" {
		t.Fatalf("status=%d requester=%q", recorder.Code, stub.requester)
	}
	if got := recorder.Body.String(); got == "" || !contains(got, "invitations") {
		t.Fatalf("unexpected envelope %s", got)
	}
	stub.err = ErrForbidden
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/organizations/org-1/invitations", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d", recorder.Code)
	}
	mux = http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/organizations/org-1/invitations", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", recorder.Code)
	}
}

func TestWriteOrganizationErrorMapsInvitationSafetyErrors(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "invalid invitation email", err: errors.New("invalid_invitation_email"), wantStatus: http.StatusBadRequest},
		{name: "existing member", err: errors.New("invitation_member_exists"), wantStatus: http.StatusConflict},
		{name: "pending invitation", err: errors.New("invitation_pending_exists"), wantStatus: http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeOrganizationError(recorder, tc.err)
			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}
			if !contains(recorder.Body.String(), tc.err.Error()) {
				t.Fatalf("response body = %q, want stable error %q", recorder.Body.String(), tc.err)
			}
		})
	}
}

func contains(value, substring string) bool {
	for i := 0; i+len(substring) <= len(value); i++ {
		if value[i:i+len(substring)] == substring {
			return true
		}
	}
	return false
}

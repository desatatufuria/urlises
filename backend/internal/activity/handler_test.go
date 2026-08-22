package activity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
)

// activityRouteStub is a routeService stub that records the exact arguments
// it was called with, mirroring groups.groupsRouteStub's pattern for
// asserting what the handler forwarded to the service layer.
type activityRouteStub struct {
	requester      string
	organizationID string
	cursor         string
	limit          int
	events         []Event
	nextCursor     string
	err            error
}

func (s *activityRouteStub) ListByOrganization(_ context.Context, requesterUserID, organizationID, cursor string, limit int) ([]Event, string, error) {
	s.requester = requesterUserID
	s.organizationID = organizationID
	s.cursor = cursor
	s.limit = limit
	return s.events, s.nextCursor, s.err
}

// activityPrincipal is a fake authMiddleware that injects an authenticated
// principal, matching groups.groupPrincipal / workspaces' equivalent.
func activityPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "admin-1"})))
	})
}

// passthroughActivityMiddleware simulates an unauthenticated caller: it
// never injects a principal into the request context.
func passthroughActivityMiddleware(next http.Handler) http.Handler { return next }

func TestActivityRouteUnauthenticatedRequestReturns401(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, passthroughActivityMiddleware, &activityRouteStub{})

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity", nil))

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestActivityRouteNonAdminReturns403WithoutLeakingEvents(t *testing.T) {
	stub := &activityRouteStub{err: access.ErrForbidden}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity", nil))

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d, body=%s", rr.Code, http.StatusForbidden, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "\"events\"") {
		t.Fatalf("forbidden response leaked an events envelope: %s", rr.Body.String())
	}
}

func TestActivityRouteAdminReturns200WithEventsAndNextCursor(t *testing.T) {
	stub := &activityRouteStub{
		events: []Event{{
			ID:             "evt-1",
			OrganizationID: "org-1",
			Kind:           KindGroupCreated,
			TargetType:     "group",
			TargetID:       "group-1",
			Metadata:       map[string]any{"groupName": "Engineering"},
			CreatedAt:      "2026-01-01T00:00:00Z",
		}},
		nextCursor: "next-token",
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rr.Code, http.StatusOK, rr.Body.String())
	}

	var body struct {
		Events     []Event `json:"events"`
		NextCursor string  `json:"nextCursor"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if len(body.Events) != 1 || body.Events[0].ID != "evt-1" {
		t.Fatalf("events = %+v, want a single evt-1 event", body.Events)
	}
	if body.NextCursor != "next-token" {
		t.Fatalf("nextCursor = %q, want %q", body.NextCursor, "next-token")
	}
	if stub.requester != "admin-1" {
		t.Fatalf("requester forwarded = %q, want %q", stub.requester, "admin-1")
	}
	if stub.organizationID != "org-1" {
		t.Fatalf("organizationID forwarded = %q, want %q", stub.organizationID, "org-1")
	}
}

func TestActivityRouteLimitOmittedDefaultsTo50(t *testing.T) {
	stub := &activityRouteStub{events: []Event{}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	if stub.limit != 50 {
		t.Fatalf("limit forwarded = %d, want 50 (the handler's default when omitted)", stub.limit)
	}
}

func TestActivityRouteMalformedLimitDefaultsTo50(t *testing.T) {
	stub := &activityRouteStub{events: []Event{}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity?limit=not-a-number", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	if stub.limit != 50 {
		t.Fatalf("limit forwarded = %d, want 50 (malformed limit must default, not error)", stub.limit)
	}
}

func TestActivityRouteHugeLimitIsForwardedForServiceToClamp(t *testing.T) {
	stub := &activityRouteStub{events: []Event{}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity?limit=5000", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	if stub.limit != 5000 {
		t.Fatalf("limit forwarded = %d, want 5000 (the handler must not itself clamp -- ListByOrganization clamps to [1,100])", stub.limit)
	}
}

func TestActivityRouteCursorPassedThroughVerbatim(t *testing.T) {
	stub := &activityRouteStub{events: []Event{}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity?cursor=abc123", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	if stub.cursor != "abc123" {
		t.Fatalf("cursor forwarded = %q, want %q", stub.cursor, "abc123")
	}
}

func TestActivityRouteMalformedCursorReturns400NotAPanicOr500(t *testing.T) {
	_, _, decodeErr := decodeCursor("not-valid-base64!!!")
	if decodeErr == nil {
		t.Fatal("expected decodeCursor to fail on garbage input for this test to be meaningful")
	}

	stub := &activityRouteStub{err: fmt.Errorf("decode activity cursor: %w", decodeErr)}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity?cursor=not-valid-base64!!!", nil))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d, body=%s", rr.Code, http.StatusBadRequest, rr.Body.String())
	}
}

func TestActivityRouteGenericServiceErrorReturns500WithoutLeakingDetail(t *testing.T) {
	stub := &activityRouteStub{err: errors.New("boom: db exploded")}
	mux := http.NewServeMux()
	RegisterRoutes(mux, activityPrincipal, stub)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/organizations/org-1/activity", nil))

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusInternalServerError)
	}
	if strings.Contains(rr.Body.String(), "boom") {
		t.Fatalf("response leaked internal error detail: %s", rr.Body.String())
	}
}

package organizations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/furia/shared-bookmark-sync/backend/internal/mailer"
	"github.com/jackc/pgx/v5/pgxpool"
)

type organizationsRouteStub struct {
	requester   string
	invitations []PendingInvitation
	err         error
	cancelErr   error
	deleteErr   error
}

func TestCreationRoutesRequireIdempotencyKey(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, organizationPrincipal, &organizationsRouteStub{}, nil, httpapi.NewIdempotencyExecutor(nil))
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
func (s *organizationsRouteStub) CreateInvitation(context.Context, string, string, CreateInvitationInput) (InvitationCreation, error) {
	return InvitationCreation{}, nil
}
func (s *organizationsRouteStub) ListInvitations(_ context.Context, requester, _ string) ([]PendingInvitation, error) {
	s.requester = requester
	return s.invitations, s.err
}
func (s *organizationsRouteStub) ResendInvitation(context.Context, string, string, string) (InvitationCreation, error) {
	return InvitationCreation{}, nil
}
func (s *organizationsRouteStub) CancelInvitation(context.Context, string, string, string) error {
	return s.cancelErr
}
func (s *organizationsRouteStub) DeleteOrganization(_ context.Context, requester, _ string) error {
	s.requester = requester
	return s.deleteErr
}

func organizationPrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: "admin-1"})))
	})
}

func TestInvitationReadRouteEnvelopeAuthAndErrors(t *testing.T) {
	stub := &organizationsRouteStub{invitations: []PendingInvitation{{ID: "invite-1", Email: "member@example.com", Status: "pending"}}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, organizationPrincipal, stub, nil)
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
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub, nil)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/organizations/org-1/invitations", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", recorder.Code)
	}
}

// Phase 2 (Slice 2) — RED: the cancel route returns 204 on success, 400 on
// ErrInvitationNotPending, and 401 when unauthenticated -- mirrors
// TestInvitationReadRouteEnvelopeAuthAndErrors's stub-driven style so this
// runs without a database.
func TestCancelInvitationRouteEnvelopeAuthAndErrors(t *testing.T) {
	stub := &organizationsRouteStub{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, organizationPrincipal, stub, nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/organizations/org-1/invitations/invite-1/cancel", nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status=%d, want 204", recorder.Code)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("body=%q, want empty", recorder.Body.String())
	}

	stub.cancelErr = ErrInvitationNotPending
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/organizations/org-1/invitations/invite-1/cancel", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("not-pending status=%d, want 400", recorder.Code)
	}

	mux = http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub, nil)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/organizations/org-1/invitations/invite-1/cancel", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d, want 401", recorder.Code)
	}
}

// Phase 4 (Slice 4) — RED: the delete-organization route returns 204 on
// success, 403 on ErrForbidden, 409 on ErrWouldOrphanMember, 404 on
// ErrNotFound, and 401 when unauthenticated -- stub-driven so this runs
// without a database, mirroring TestCancelInvitationRouteEnvelopeAuthAndErrors.
func TestDeleteOrganizationRouteEnvelopeAuthAndErrors(t *testing.T) {
	stub := &organizationsRouteStub{}
	mux := http.NewServeMux()
	RegisterRoutes(mux, organizationPrincipal, stub, nil)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/org-1", nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status=%d, want 204", recorder.Code)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("body=%q, want empty", recorder.Body.String())
	}
	if stub.requester != "admin-1" {
		t.Fatalf("requester=%q, want admin-1", stub.requester)
	}

	stub.deleteErr = ErrForbidden
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/org-1", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d, want 403", recorder.Code)
	}

	stub.deleteErr = ErrWouldOrphanMember
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/org-1", nil))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("orphan status=%d, want 409", recorder.Code)
	}

	stub.deleteErr = ErrNotFound
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/org-1", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("not found status=%d, want 404", recorder.Code)
	}

	mux = http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler { return next }, stub, nil)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/organizations/org-1", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d, want 401", recorder.Code)
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
		{name: "invitation not pending", err: errors.New("invitation is not pending"), wantStatus: http.StatusBadRequest},
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

type countingInvitationNotifier struct {
	mu    sync.Mutex
	calls int
	err   error
}

func (n *countingInvitationNotifier) NotifyInvitation(context.Context, InvitationNotification) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls++
	return n.err
}

func (n *countingInvitationNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.calls
}

func invitationHandlerTestMux(userID string, pool *pgxpool.Pool, notifier invitationNotifier) *http.ServeMux {
	mux := http.NewServeMux()
	authn := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID})))
		})
	}
	executor := httpapi.NewIdempotencyExecutor(pool)
	RegisterRoutes(mux, authn, NewService(pool, activity.NewService(pool)), notifier, executor)
	return mux
}

// 4.2 RED: a fresh command invokes a counting notifier stub exactly once.
func TestInvitationRouteInvokesNotifierOnceOnFreshCommand(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_notify_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "notify-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Notify Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	r := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"fresh@example.com","role":"member"}`))
	r.Header.Set("Idempotency-Key", "fresh-key")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls = %d, want 1", notifier.count())
	}
}

// 4.2 RED: an idempotent replay invokes the notifier zero times.
func TestInvitationRouteReplayDoesNotReinvokeNotifier(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_notify_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "replay-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Replay Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)
	body := `{"email":"replay@example.com","role":"member"}`

	for i := 0; i < 2; i++ {
		r := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(body))
		r.Header.Set("Idempotency-Key", "replay-key")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusCreated {
			t.Fatalf("attempt %d status=%d body=%s", i, w.Code, w.Body.String())
		}
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls = %d, want 1 (replay must not re-send)", notifier.count())
	}
}

// 4.2 RED: a notifier error still yields 201 with the created body.
func TestInvitationRouteNotifierErrorStillReturns201(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_notify_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "erroring-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Erroring Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{err: errors.New("smtp down")}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	r := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"erroring@example.com","role":"member"}`))
	r.Header.Set("Idempotency-Key", "erroring-key")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "erroring@example.com") {
		t.Fatalf("body=%s, want created invitation despite notifier error", w.Body.String())
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls = %d, want 1", notifier.count())
	}
}

// 4.2 RED: a fingerprint conflict (same key, different body) sends nothing.
func TestInvitationRouteFingerprintConflictSendsNothing(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_notify_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "conflict-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Conflict Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	first := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"conflict-one@example.com","role":"member"}`))
	first.Header.Set("Idempotency-Key", "conflict-key")
	w1 := httptest.NewRecorder()
	mux.ServeHTTP(w1, first)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first status=%d body=%s", w1.Code, w1.Body.String())
	}

	second := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"conflict-two@example.com","role":"member"}`))
	second.Header.Set("Idempotency-Key", "conflict-key")
	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, second)
	if w2.Code != http.StatusConflict {
		t.Fatalf("second status=%d body=%s", w2.Code, w2.Body.String())
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls = %d, want 1 (conflict must send nothing)", notifier.count())
	}
}

// 8.1: MAIL_ENABLED=false still returns mailer.ErrDisabled (logged), with
// invitation creation otherwise unaffected — exercised through the real
// mailer.NewSMTP + MailInvitationNotifier composition used by main.go.
func TestInvitationRouteWithDisabledMailerStillCreatesInvitation(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_disabled_mail_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "disabled-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Disabled Mail Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	disabledMailer := mailer.NewSMTP(config.MailConfig{Enabled: false})
	var logBuffer bytes.Buffer
	notifier := NewMailInvitationNotifier(disabledMailer, "https://admin.example.com", &logBuffer)
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	r := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"disabled-mail@example.com","role":"member"}`))
	r.Header.Set("Idempotency-Key", "disabled-mail-key")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "disabled-mail@example.com") {
		t.Fatalf("body=%s, want created invitation despite disabled mail", w.Body.String())
	}

	logOutput := logBuffer.String()
	if !contains(logOutput, "event=invitation_email_failed") || !contains(logOutput, "reason=disabled") {
		t.Fatalf("log=%q, want disabled-mail failure logged", logOutput)
	}

	var storedCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM invitations WHERE organization_id = $1 AND email = $2`, organizationID, "disabled-mail@example.com").Scan(&storedCount); err != nil {
		t.Fatalf("query stored invitation: %v", err)
	}
	if storedCount != 1 {
		t.Fatalf("stored invitation count = %d, want 1 (creation unaffected by disabled mail)", storedCount)
	}
}

// Phase 9: Invitation Resend — RED: resend refreshes expires_at and
// triggers exactly one notifier call, mirroring
// TestInvitationRouteInvokesNotifierOnceOnFreshCommand's style.
func TestResendInvitationRouteRefreshesExpiryAndNotifiesOnce(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_resend_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "resend-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Route Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	createReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"resend-target@example.com","role":"member"}`))
	createReq.Header.Set("Idempotency-Key", "resend-create-key")
	createW := httptest.NewRecorder()
	mux.ServeHTTP(createW, createReq)
	if createW.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createW.Code, createW.Body.String())
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls after create = %d, want 1", notifier.count())
	}

	var created struct {
		ID        string  `json:"id"`
		ExpiresAt *string `json:"expiresAt"`
	}
	if err := json.Unmarshal(createW.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created invitation: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE invitations SET expires_at = $2 WHERE id = $1`, created.ID, time.Now().UTC().Add(-time.Minute)); err != nil {
		t.Fatalf("force past expiry: %v", err)
	}

	resendReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/"+created.ID+"/resend", nil)
	resendW := httptest.NewRecorder()
	mux.ServeHTTP(resendW, resendReq)
	if resendW.Code != http.StatusOK {
		t.Fatalf("resend status=%d body=%s", resendW.Code, resendW.Body.String())
	}
	if !contains(resendW.Body.String(), "resend-target@example.com") {
		t.Fatalf("resend body=%s, want the invitation", resendW.Body.String())
	}
	if notifier.count() != 2 {
		t.Fatalf("notifier calls after resend = %d, want 2", notifier.count())
	}

	var resent struct {
		ExpiresAt *string `json:"expiresAt"`
	}
	if err := json.Unmarshal(resendW.Body.Bytes(), &resent); err != nil {
		t.Fatalf("decode resent invitation: %v", err)
	}
	if resent.ExpiresAt == nil || created.ExpiresAt == nil || *resent.ExpiresAt == *created.ExpiresAt {
		t.Fatalf("resent expiresAt = %v, want refreshed from %v", resent.ExpiresAt, created.ExpiresAt)
	}
}

// Phase 9: Invitation Resend — RED: resend on a non-pending invitation
// (already accepted) is rejected and sends nothing.
func TestResendInvitationRouteRejectsNonPending(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_resend_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "resend-admin2@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "resend-invitee2@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Route Org 2")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	service := NewService(pool, activity.NewService(pool))
	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "resend-invitee2@example.com", Role: "member"})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if _, err := service.AcceptInvitation(ctx, inviteeID, created.Invitation.Token); err != nil {
		t.Fatalf("accept invitation: %v", err)
	}

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	resendReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/"+created.Invitation.ID+"/resend", nil)
	resendW := httptest.NewRecorder()
	mux.ServeHTTP(resendW, resendReq)
	if resendW.Code != http.StatusBadRequest {
		t.Fatalf("resend status=%d body=%s, want 400", resendW.Code, resendW.Body.String())
	}
	if notifier.count() != 0 {
		t.Fatalf("notifier calls = %d, want 0", notifier.count())
	}
}

// Phase 9: Invitation Resend — RED: resend requires org admin auth, same as
// creation.
func TestResendInvitationRouteRequiresAdmin(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_resend_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "resend-admin3@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "resend-member3@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Resend Route Org 3")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	service := NewService(pool, activity.NewService(pool))
	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "resend-target3@example.com", Role: "member"})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(memberID, pool, notifier)

	resendReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/"+created.Invitation.ID+"/resend", nil)
	resendW := httptest.NewRecorder()
	mux.ServeHTTP(resendW, resendReq)
	if resendW.Code != http.StatusForbidden {
		t.Fatalf("resend status=%d body=%s, want 403", resendW.Code, resendW.Body.String())
	}
	if notifier.count() != 0 {
		t.Fatalf("notifier calls = %d, want 0", notifier.count())
	}
}

// Phase 2 (Slice 2): Cancel Pending Invitation — RED: cancelling a pending
// invitation succeeds with 204 and no body, mirroring the removal
// convention (PATCH .../members {remove:true} -> 204).
func TestCancelInvitationRouteSucceedsWithNoContent(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_cancel_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-route-admin@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Route Org")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	createReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations", strings.NewReader(`{"email":"cancel-target@example.com","role":"member"}`))
	createReq.Header.Set("Idempotency-Key", "cancel-create-key")
	createW := httptest.NewRecorder()
	mux.ServeHTTP(createW, createReq)
	if createW.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createW.Code, createW.Body.String())
	}

	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(createW.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created invitation: %v", err)
	}

	cancelReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/"+created.ID+"/cancel", nil)
	cancelW := httptest.NewRecorder()
	mux.ServeHTTP(cancelW, cancelReq)
	if cancelW.Code != http.StatusNoContent {
		t.Fatalf("cancel status=%d body=%s, want 204", cancelW.Code, cancelW.Body.String())
	}
	if cancelW.Body.Len() != 0 {
		t.Fatalf("cancel body=%q, want empty", cancelW.Body.String())
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM invitations WHERE id = $1`, created.ID).Scan(&status); err != nil {
		t.Fatalf("query invitation status: %v", err)
	}
	if status != "cancelled" {
		t.Fatalf("invitation status = %q, want cancelled", status)
	}
}

// Phase 2 (Slice 2) — RED: a non-admin member is forbidden.
func TestCancelInvitationRouteRequiresAdmin(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_cancel_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-route-admin2@example.com")
	memberID := insertOrganizationsTestUser(t, ctx, pool, "cancel-route-member2@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Route Org 2")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, memberID, "member")

	service := NewService(pool, activity.NewService(pool))
	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "cancel-target2@example.com", Role: "member"})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(memberID, pool, notifier)

	cancelReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/"+created.Invitation.ID+"/cancel", nil)
	cancelW := httptest.NewRecorder()
	mux.ServeHTTP(cancelW, cancelReq)
	if cancelW.Code != http.StatusForbidden {
		t.Fatalf("cancel status=%d body=%s, want 403", cancelW.Code, cancelW.Body.String())
	}
}

// Phase 2 (Slice 2) — RED: a non-pending invitation returns 400.
func TestCancelInvitationRouteRejectsNonPending(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_cancel_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-route-admin3@example.com")
	inviteeID := insertOrganizationsTestUser(t, ctx, pool, "cancel-route-invitee3@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Route Org 3")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	service := NewService(pool, activity.NewService(pool))
	created, err := service.CreateInvitation(ctx, adminID, organizationID, CreateInvitationInput{Email: "cancel-target3@example.com", Role: "member"})
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	if _, err := service.AcceptInvitation(ctx, inviteeID, created.Invitation.Token); err != nil {
		t.Fatalf("accept invitation: %v", err)
	}

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	cancelReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/"+created.Invitation.ID+"/cancel", nil)
	cancelW := httptest.NewRecorder()
	mux.ServeHTTP(cancelW, cancelReq)
	if cancelW.Code != http.StatusBadRequest {
		t.Fatalf("cancel status=%d body=%s, want 400", cancelW.Code, cancelW.Body.String())
	}
}

// Phase 2 (Slice 2) — RED: an unknown invitation ID returns 404.
func TestCancelInvitationRouteUnknownInvitationReturnsNotFound(t *testing.T) {
	ctx, pool := openOrganizationsTestPool(t, "organizations_handler_cancel_test")
	adminID := insertOrganizationsTestUser(t, ctx, pool, "cancel-route-admin4@example.com")
	organizationID := insertOrganizationsTestOrganization(t, ctx, pool, "Cancel Route Org 4")
	insertOrganizationsTestMember(t, ctx, pool, organizationID, adminID, "admin")

	notifier := &countingInvitationNotifier{}
	mux := invitationHandlerTestMux(adminID, pool, notifier)

	cancelReq := httptest.NewRequest(http.MethodPost, "/organizations/"+organizationID+"/invitations/00000000-0000-0000-0000-000000000000/cancel", nil)
	cancelW := httptest.NewRecorder()
	mux.ServeHTTP(cancelW, cancelReq)
	if cancelW.Code != http.StatusNotFound {
		t.Fatalf("cancel status=%d body=%s, want 404", cancelW.Code, cancelW.Body.String())
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

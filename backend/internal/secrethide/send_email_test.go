package secrethide

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// --- Test doubles ---

// stubSendEmailService implements routeService without a database, so the
// authorization-critical LoadOwned path can be unit-tested deterministically
// (unknown token / wrong owner / wrong status must all collapse into the
// same ErrNotFound response).
type stubSendEmailService struct {
	loadOwnedSecret Secret
	loadOwnedErr    error

	mu             sync.Mutex
	loadOwnedCalls []struct{ token, userID string }
}

func (s *stubSendEmailService) Create(context.Context, string, CreateSecretInput) (Secret, error) {
	return Secret{}, errors.New("unused in these tests")
}

func (s *stubSendEmailService) Reveal(context.Context, string) (SecretBlob, error) {
	return SecretBlob{}, errors.New("unused in these tests")
}

func (s *stubSendEmailService) Burn(context.Context, string) (string, string, bool, error) {
	return "", "", false, errors.New("unused in these tests")
}

func (s *stubSendEmailService) LoadOwned(_ context.Context, token, userID string) (Secret, error) {
	s.mu.Lock()
	s.loadOwnedCalls = append(s.loadOwnedCalls, struct{ token, userID string }{token, userID})
	s.mu.Unlock()

	if s.loadOwnedErr != nil {
		return Secret{}, s.loadOwnedErr
	}
	return s.loadOwnedSecret, nil
}

func (s *stubSendEmailService) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.loadOwnedCalls)
}

// recordingSecretLinkMailer is a secretLinkMailer test double that records
// every notification it was asked to send.
type recordingSecretLinkMailer struct {
	err error

	mu            sync.Mutex
	notifications []SecretLinkNotification
}

func (m *recordingSecretLinkMailer) SendSecretLink(_ context.Context, notification SecretLinkNotification) error {
	m.mu.Lock()
	m.notifications = append(m.notifications, notification)
	m.mu.Unlock()
	return m.err
}

func (m *recordingSecretLinkMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.notifications)
}

func (m *recordingSecretLinkMailer) last() SecretLinkNotification {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.notifications[len(m.notifications)-1]
}

func sendEmailTestMux(userID string, service routeService, linkMailer secretLinkMailer) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterRoutes(mux, secretsPrincipal(userID), service, nil, linkMailer)
	return mux
}

func sendEmailRequest(token, body string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/secrets/"+token+"/send-email", strings.NewReader(body))
}

// --- Authentication ---

func TestSendSecretLinkRequiresAuthentication(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{}
	linkMailer := &recordingSecretLinkMailer{}

	mux := http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Deliberately does NOT attach a principal, simulating
			// authMiddleware rejecting an unauthenticated caller.
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		})
	}, service, nil, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com"}`))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if linkMailer.count() != 0 {
		t.Fatalf("mailer calls = %d, want 0 for an unauthenticated request", linkMailer.count())
	}
	if service.callCount() != 0 {
		t.Fatalf("LoadOwned calls = %d, want 0 for an unauthenticated request", service.callCount())
	}
}

// --- Authorization: unknown token / wrong owner / wrong status must be
// indistinguishable from the caller's point of view ---

func TestSendSecretLinkUnknownTokenReturnsGenericNotFound(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{loadOwnedErr: ErrNotFound}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("does-not-exist", `{"recipientEmail":"friend@example.com"}`))

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusNotFound, w.Body.String())
	}
	if linkMailer.count() != 0 {
		t.Fatalf("mailer calls = %d, want 0", linkMailer.count())
	}
	if service.callCount() != 1 {
		t.Fatalf("LoadOwned calls = %d, want 1", service.callCount())
	}
	call := service.loadOwnedCalls[0]
	if call.token != "does-not-exist" || call.userID != "user-1" {
		t.Fatalf("LoadOwned called with (%q, %q), want (%q, %q)", call.token, call.userID, "does-not-exist", "user-1")
	}
}

func TestSendSecretLinkWrongOwnerAndWrongStatusCollapseToTheSameResponseAsUnknownToken(t *testing.T) {
	t.Parallel()

	// All three causes must be indistinguishable: the service already
	// collapses them into ErrNotFound (see service.go's LoadOwned), and the
	// handler must not add any distinguishing behavior on top.
	scenarios := map[string]error{
		"unknown token": ErrNotFound,
		"wrong owner":   ErrNotFound,
		"wrong status":  ErrNotFound,
	}

	var bodies []string
	var statuses []int
	for name, loadErr := range scenarios {
		service := &stubSendEmailService{loadOwnedErr: loadErr}
		linkMailer := &recordingSecretLinkMailer{}
		mux := sendEmailTestMux("user-1", service, linkMailer)

		w := httptest.NewRecorder()
		mux.ServeHTTP(w, sendEmailRequest("irrelevant-token", `{"recipientEmail":"friend@example.com"}`))

		if linkMailer.count() != 0 {
			t.Fatalf("%s: mailer calls = %d, want 0", name, linkMailer.count())
		}
		statuses = append(statuses, w.Code)
		bodies = append(bodies, w.Body.String())
	}

	for i := range statuses {
		if statuses[i] != http.StatusNotFound {
			t.Fatalf("scenario %d: status = %d, want %d", i, statuses[i], http.StatusNotFound)
		}
		if bodies[i] != bodies[0] {
			t.Fatalf("scenario %d: body = %q, want identical to scenario 0's body %q (must not be distinguishable)", i, bodies[i], bodies[0])
		}
	}
}

func TestSendSecretLinkOnlyOwnerCanTriggerSend(t *testing.T) {
	t.Parallel()

	// The service is the actual authorization boundary: LoadOwned is called
	// with the authenticated caller's own userID, never a client-supplied
	// one, so a caller can never ask to send another user's secret.
	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "owner-user", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("caller-user", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com"}`))

	if service.callCount() != 1 {
		t.Fatalf("LoadOwned calls = %d, want 1", service.callCount())
	}
	if service.loadOwnedCalls[0].userID != "caller-user" {
		t.Fatalf("LoadOwned userID = %q, want the authenticated caller %q (never client-supplied)", service.loadOwnedCalls[0].userID, "caller-user")
	}
	_ = w
}

// --- Success path: fragment-only acceptance and mailer invocation ---

func TestSendSecretLinkSuccessCallsMailerWithReconstructedLinkParts(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"Friend@Example.com","fragment":"k=AbCdEf"}`))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusOK, w.Body.String())
	}
	var response struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, w.Body.String())
	}
	if response.Status != "sent" {
		t.Fatalf("response.Status = %q, want %q", response.Status, "sent")
	}

	if linkMailer.count() != 1 {
		t.Fatalf("mailer calls = %d, want 1", linkMailer.count())
	}
	notification := linkMailer.last()
	if notification.SecretID != "secret-1" {
		t.Fatalf("notification.SecretID = %q, want %q", notification.SecretID, "secret-1")
	}
	if notification.Token != "tok123" {
		t.Fatalf("notification.Token = %q, want %q", notification.Token, "tok123")
	}
	if notification.Fragment != "k=AbCdEf" {
		t.Fatalf("notification.Fragment = %q, want %q", notification.Fragment, "k=AbCdEf")
	}
	if notification.RecipientEmail != "friend@example.com" {
		t.Fatalf("notification.RecipientEmail = %q, want normalized %q", notification.RecipientEmail, "friend@example.com")
	}
}

func TestSendSecretLinkSuccessWithoutFragment(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com"}`))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusOK, w.Body.String())
	}
	if notification := linkMailer.last(); notification.Fragment != "" {
		t.Fatalf("notification.Fragment = %q, want empty", notification.Fragment)
	}
}

// --- Task: the client can never smuggle a free-text link/origin ---

func TestSendSecretLinkRejectsArbitraryLinkField(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com","link":"https://evil.example/phish"}`))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if linkMailer.count() != 0 {
		t.Fatalf("mailer calls = %d, want 0", linkMailer.count())
	}
}

func TestSendSecretLinkRejectsInvalidRecipientEmail(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"not-an-email"}`))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if linkMailer.count() != 0 {
		t.Fatalf("mailer calls = %d, want 0", linkMailer.count())
	}
	if service.callCount() != 0 {
		t.Fatalf("LoadOwned calls = %d, want 0 (validation must happen before touching the service)", service.callCount())
	}
}

func TestSendSecretLinkRejectsMissingRecipientEmail(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"fragment":"k=AbCdEf"}`))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestSendSecretLinkRejectsFragmentContainingCRLF(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com","fragment":"k=Ab\r\nBcc: attacker@evil.example"}`))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if linkMailer.count() != 0 {
		t.Fatalf("mailer calls = %d, want 0", linkMailer.count())
	}
}

func TestSendSecretLinkRejectsOversizedFragment(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	oversized := strings.Repeat("A", maxFragmentBytes+1)
	body, err := json.Marshal(map[string]string{"recipientEmail": "friend@example.com", "fragment": oversized})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", string(body)))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if linkMailer.count() != 0 {
		t.Fatalf("mailer calls = %d, want 0", linkMailer.count())
	}
}

// --- Mailer failure: generic response, no detail leaked to the client ---

func TestSendSecretLinkMailerFailureReturnsGenericErrorWithoutLeakingDetail(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	linkMailer := &recordingSecretLinkMailer{err: errors.New("smtp dial failed")}
	mux := sendEmailTestMux("user-1", service, linkMailer)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com"}`))

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadGateway, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "smtp dial failed") {
		t.Fatalf("response body leaked mailer error detail: %s", w.Body.String())
	}
}

func TestSendSecretLinkWithoutConfiguredMailerReturnsServiceUnavailable(t *testing.T) {
	t.Parallel()

	service := &stubSendEmailService{
		loadOwnedSecret: Secret{ID: "secret-1", UserID: "user-1", Token: "tok123", Status: "pending"},
	}
	mux := sendEmailTestMux("user-1", service, nil)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, sendEmailRequest("tok123", `{"recipientEmail":"friend@example.com"}`))

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusServiceUnavailable, w.Body.String())
	}
}

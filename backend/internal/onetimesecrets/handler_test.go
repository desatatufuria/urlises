package onetimesecrets

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

// --- Test helpers (mirrors organizations' invitationHandlerTestMux pattern) ---

type countingSecretReadNotifier struct {
	mu             sync.Mutex
	calls          int
	creatorUserIDs []string
	secretIDs      []string
}

func (n *countingSecretReadNotifier) NotifySecretRead(_ context.Context, creatorUserID, secretID string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls++
	n.creatorUserIDs = append(n.creatorUserIDs, creatorUserID)
	n.secretIDs = append(n.secretIDs, secretID)
	return nil
}

func (n *countingSecretReadNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.calls
}

func secretsPrincipal(userID string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), auth.Principal{UserID: userID})))
		})
	}
}

func secretsHandlerTestMux(userID string, pool *pgxpool.Pool, notifier secretReadNotifier) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterRoutes(mux, secretsPrincipal(userID), NewService(pool), notifier)
	return mux
}

func countTestSecretRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int {
	t.Helper()

	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM secrets`).Scan(&count); err != nil {
		t.Fatalf("count secrets: %v", err)
	}
	return count
}

// --- Task 2.1: POST /secrets validation ---

func TestCreateSecretRejectsPlaintextField(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_plaintext_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-plaintext@example.com")
	mux := secretsHandlerTestMux(userID, pool, nil)

	before := countTestSecretRows(t, ctx, pool)

	r := httptest.NewRequest(http.MethodPost, "/secrets", strings.NewReader(`{"ciphertext":"Y2lwaGVydGV4dA==","iv":"aXZieXRlcw==","plaintext":"leaked secret"}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if after := countTestSecretRows(t, ctx, pool); after != before {
		t.Fatalf("secret row count = %d, want unchanged %d (plaintext field must not persist a row)", after, before)
	}
}

func TestCreateSecretRejectsPassphraseField(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_passphrase_field_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-passphrase-field@example.com")
	mux := secretsHandlerTestMux(userID, pool, nil)

	before := countTestSecretRows(t, ctx, pool)

	r := httptest.NewRequest(http.MethodPost, "/secrets", strings.NewReader(`{"ciphertext":"Y2lwaGVydGV4dA==","iv":"aXZieXRlcw==","passphrase":"hunter2"}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if after := countTestSecretRows(t, ctx, pool); after != before {
		t.Fatalf("secret row count = %d, want unchanged %d (passphrase field must not persist a row)", after, before)
	}
}

func TestCreateSecretRejectsOversizedCiphertext(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_oversized_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-oversized@example.com")
	mux := secretsHandlerTestMux(userID, pool, nil)

	before := countTestSecretRows(t, ctx, pool)

	oversized := strings.Repeat("A", 64*1024+1)
	body, err := json.Marshal(map[string]string{"ciphertext": oversized, "iv": "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	r := httptest.NewRequest(http.MethodPost, "/secrets", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusBadRequest, w.Body.String())
	}
	if after := countTestSecretRows(t, ctx, pool); after != before {
		t.Fatalf("secret row count = %d, want unchanged %d (oversized ciphertext must not persist a row)", after, before)
	}
}

func TestCreateSecretPersistsPassphraseFieldsVerbatim(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_verbatim_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-verbatim@example.com")
	mux := secretsHandlerTestMux(userID, pool, nil)

	r := httptest.NewRequest(http.MethodPost, "/secrets", strings.NewReader(`{
		"ciphertext":"Y2lwaGVydGV4dA==",
		"iv":"aXZieXRlcw==",
		"wrappedContentKey":"d3JhcHBlZGtleQ==",
		"passphraseSalt":"c2FsdGJ5dGVz",
		"kdfIterations":210000
	}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusCreated, w.Body.String())
	}

	var created struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v; body=%s", err, w.Body.String())
	}
	if created.Token == "" {
		t.Fatalf("response token is empty; body=%s", w.Body.String())
	}

	service := NewService(pool)
	blob, err := service.Reveal(ctx, created.Token)
	if err != nil {
		t.Fatalf("reveal persisted secret: %v", err)
	}
	if blob.WrappedContentKey == nil || *blob.WrappedContentKey != "d3JhcHBlZGtleQ==" {
		t.Fatalf("blob.WrappedContentKey = %v, want %q", blob.WrappedContentKey, "d3JhcHBlZGtleQ==")
	}
	if blob.PassphraseSalt == nil || *blob.PassphraseSalt != "c2FsdGJ5dGVz" {
		t.Fatalf("blob.PassphraseSalt = %v, want %q", blob.PassphraseSalt, "c2FsdGJ5dGVz")
	}
	if blob.KDFIterations == nil || *blob.KDFIterations != 210000 {
		t.Fatalf("blob.KDFIterations = %v, want %d", blob.KDFIterations, 210000)
	}
}

func TestCreateSecretRequiresAuthentication(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_unauth_test")
	mux := http.NewServeMux()
	RegisterRoutes(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Deliberately does NOT attach a principal, simulating
			// authMiddleware rejecting an unauthenticated caller.
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		})
	}, NewService(pool), nil)

	before := countTestSecretRows(t, ctx, pool)
	r := httptest.NewRequest(http.MethodPost, "/secrets", strings.NewReader(`{"ciphertext":"Y2lwaGVydGV4dA==","iv":"aXZieXRlcw=="}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if after := countTestSecretRows(t, ctx, pool); after != before {
		t.Fatalf("secret row count = %d, want unchanged %d", after, before)
	}
}

// --- Task 2.2: GET /secrets/{token} ---

func TestGetSecretReturnsBlobWithoutBurningAndIsRepeatable(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_get_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-get@example.com")
	service := NewService(pool)
	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	mux := secretsHandlerTestMux(userID, pool, nil)

	for attempt := 0; attempt < 2; attempt++ {
		r := httptest.NewRequest(http.MethodGet, "/secrets/"+created.Token, nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)

		if w.Code != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, want %d; body=%s", attempt, w.Code, http.StatusOK, w.Body.String())
		}
		var blob struct {
			Ciphertext string `json:"ciphertext"`
			IV         string `json:"iv"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &blob); err != nil {
			t.Fatalf("attempt %d: decode blob: %v; body=%s", attempt, err, w.Body.String())
		}
		if blob.Ciphertext != "Y2lwaGVydGV4dA==" {
			t.Fatalf("attempt %d: blob.Ciphertext = %q, want %q", attempt, blob.Ciphertext, "Y2lwaGVydGV4dA==")
		}
	}

	status := loadOnetimesecretsTestStatus(t, ctx, pool, created.ID)
	if status != "pending" {
		t.Fatalf("status after two GETs = %q, want pending (GET must never burn)", status)
	}
}

func TestGetSecretUnknownTokenReturns404(t *testing.T) {
	t.Parallel()

	_, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_get_unknown_test")
	mux := secretsHandlerTestMux("irrelevant", pool, nil)

	r := httptest.NewRequest(http.MethodGet, "/secrets/does-not-exist", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusNotFound, w.Body.String())
	}
}

func TestGetSecretExpiredTokenReturns410WithNoCiphertextBody(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_get_expired_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-get-expired@example.com")
	service := NewService(pool)
	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}
	forceOnetimesecretsTestExpiry(t, ctx, pool, created.ID)

	mux := secretsHandlerTestMux(userID, pool, nil)
	r := httptest.NewRequest(http.MethodGet, "/secrets/"+created.Token, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusGone {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusGone, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "Y2lwaGVydGV4dA==") {
		t.Fatalf("410 response leaked ciphertext: body=%s", w.Body.String())
	}
}

func TestGetSecretAlreadyReadTokenReturns410(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_get_already_read_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-get-already-read@example.com")
	service := NewService(pool)
	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}
	if _, _, _, err := service.Burn(ctx, created.Token); err != nil {
		t.Fatalf("burn secret: %v", err)
	}

	mux := secretsHandlerTestMux(userID, pool, nil)
	r := httptest.NewRequest(http.MethodGet, "/secrets/"+created.Token, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)

	if w.Code != http.StatusGone {
		t.Fatalf("status = %d, want %d; body=%s", w.Code, http.StatusGone, w.Body.String())
	}
}

// --- Task 2.3: POST /secrets/{token}/burn ---

func TestBurnSecretAfterFetchSetsStatusRead(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_burn_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-handler-burn@example.com")
	service := NewService(pool)
	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	notifier := &countingSecretReadNotifier{}
	mux := secretsHandlerTestMux(userID, pool, notifier)

	getReq := httptest.NewRequest(http.MethodGet, "/secrets/"+created.Token, nil)
	getResp := httptest.NewRecorder()
	mux.ServeHTTP(getResp, getReq)
	if getResp.Code != http.StatusOK {
		t.Fatalf("fetch before burn: status = %d, body=%s", getResp.Code, getResp.Body.String())
	}

	burnReq := httptest.NewRequest(http.MethodPost, "/secrets/"+created.Token+"/burn", nil)
	burnResp := httptest.NewRecorder()
	mux.ServeHTTP(burnResp, burnReq)
	if burnResp.Code != http.StatusOK {
		t.Fatalf("burn: status = %d, body=%s", burnResp.Code, burnResp.Body.String())
	}

	status := loadOnetimesecretsTestStatus(t, ctx, pool, created.ID)
	if status != "read" {
		t.Fatalf("status after burn = %q, want read", status)
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls = %d, want 1 on fresh burn", notifier.count())
	}
}

func TestBurnSecretRepeatedCallIsIdempotentAndDoesNotChangeReadAt(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_handler_burn_idempotent_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-handler-burn-idempotent@example.com")
	service := NewService(pool)
	created, err := service.Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	notifier := &countingSecretReadNotifier{}
	mux := secretsHandlerTestMux(userID, pool, notifier)

	for attempt := 0; attempt < 2; attempt++ {
		r := httptest.NewRequest(http.MethodPost, "/secrets/"+created.Token+"/burn", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, want %d; body=%s", attempt, w.Code, http.StatusOK, w.Body.String())
		}
	}

	_, readAt := loadOnetimesecretsTestStatusAndReadAt(t, ctx, pool, created.ID)
	if readAt == nil {
		t.Fatal("read_at is nil after burn, want non-nil")
	}
	if notifier.count() != 1 {
		t.Fatalf("notifier calls = %d, want 1 (repeated burn must not re-notify)", notifier.count())
	}
}

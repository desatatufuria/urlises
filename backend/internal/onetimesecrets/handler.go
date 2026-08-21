package onetimesecrets

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
)

// maxCiphertextBase64Bytes is the maximum accepted ciphertext payload size,
// measured on the raw base64-encoded wire value (not the decoded byte
// count), per the spec's "64 KB (base64-encoded)" limit.
const maxCiphertextBase64Bytes = 64 * 1024

// allowedCreateSecretFields is the exhaustive set of keys POST /secrets
// accepts. Any other key — most importantly plaintext-shaped fields like
// "plaintext" or "passphrase" — is rejected before the request is
// unmarshalled any further, so a client can never smuggle unencrypted
// content or the passphrase itself into the request.
var allowedCreateSecretFields = map[string]struct{}{
	"ciphertext":        {},
	"iv":                {},
	"wrappedContentKey": {},
	"passphraseSalt":    {},
	"kdfIterations":     {},
	"ttlSeconds":        {},
}

// routeService is the subset of *Service the handler depends on, mirroring
// organizations' routeService seam so the handler can be tested against a
// stub without a database.
type routeService interface {
	Create(ctx context.Context, userID string, input CreateSecretInput) (Secret, error)
	Reveal(ctx context.Context, token string) (SecretBlob, error)
	Burn(ctx context.Context, token string) (creatorUserID string, secretID string, alreadyRead bool, err error)
}

// secretReadNotifier is a narrow, consumer-defined port so this package
// depends only on the shape of notification it needs, not on
// internal/websocket directly at the handler boundary — matching
// organizations' invitationNotifier shape. The concrete implementation
// backed by *websocket.Hub.PublishToUser is wired in main.go once the Hub
// gains that method (a later work unit); until then RegisterRoutes is
// composable with NoopSecretReadNotifier or a nil notifier.
type secretReadNotifier interface {
	NotifySecretRead(ctx context.Context, creatorUserID, secretID string) error
}

// NoopSecretReadNotifier is a secretReadNotifier stub that does nothing. It
// lets RegisterRoutes be wired today without depending on
// websocket.Hub.PublishToUser, which does not exist yet.
type NoopSecretReadNotifier struct{}

// NotifySecretRead implements secretReadNotifier and is a deliberate no-op.
func (NoopSecretReadNotifier) NotifySecretRead(context.Context, string, string) error {
	return nil
}

// RegisterRoutes wires the one-time-secrets endpoints onto mux. POST
// /secrets runs behind authMiddleware; GET /secrets/{token} and POST
// /secrets/{token}/burn are unauthenticated and rate-limited per IP. A nil
// notifier is treated the same as NoopSecretReadNotifier.
func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, notifier secretReadNotifier) {
	limiter := httpapi.NewIPRateLimiter(30, 0.5)

	mux.Handle("POST /secrets", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		input, err := decodeCreateSecretInput(r)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		secret, err := service.Create(r.Context(), principal.UserID, input)
		if err != nil {
			writeSecretError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusCreated, secretCreationView(secret))
	})))

	mux.Handle("GET /secrets/{token}", limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		blob, err := service.Reveal(r.Context(), r.PathValue("token"))
		if err != nil {
			writeSecretError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, secretBlobView(blob))
	})))

	mux.Handle("POST /secrets/{token}/burn", limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		creatorUserID, secretID, alreadyRead, err := service.Burn(r.Context(), r.PathValue("token"))
		if err != nil {
			writeSecretError(w, err)
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]string{"status": "read"})

		if !alreadyRead && notifier != nil {
			_ = http.NewResponseController(w).Flush()
			_ = notifier.NotifySecretRead(context.WithoutCancel(r.Context()), creatorUserID, secretID)
		}
	})))
}

// decodeCreateSecretInput enforces the field allow-list and the
// content-size limit before unmarshalling into CreateSecretInput. It first
// decodes into a map[string]json.RawMessage so any key outside the
// allow-list — including "plaintext" or "passphrase" — is rejected without
// ever being interpreted as request data, and so the 64 KB ciphertext
// check runs on the raw wire value before any further unmarshalling.
func decodeCreateSecretInput(r *http.Request) (CreateSecretInput, error) {
	defer r.Body.Close()

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return CreateSecretInput{}, errors.New("read request body")
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return CreateSecretInput{}, errors.New("invalid request body")
	}

	for key := range raw {
		if _, ok := allowedCreateSecretFields[key]; !ok {
			return CreateSecretInput{}, errors.New("unsupported field: " + key)
		}
	}

	if ciphertextRaw, ok := raw["ciphertext"]; ok {
		var ciphertext string
		if err := json.Unmarshal(ciphertextRaw, &ciphertext); err != nil {
			return CreateSecretInput{}, errors.New("invalid ciphertext")
		}
		if len(ciphertext) > maxCiphertextBase64Bytes {
			return CreateSecretInput{}, errors.New("ciphertext exceeds maximum size")
		}
	}

	var input CreateSecretInput
	if err := json.Unmarshal(body, &input); err != nil {
		return CreateSecretInput{}, errors.New("invalid request body")
	}

	return input, nil
}

func secretCreationView(secret Secret) map[string]any {
	return map[string]any{
		"id":        secret.ID,
		"token":     secret.Token,
		"createdAt": secret.CreatedAt,
		"expiresAt": secret.ExpiresAt,
	}
}

func secretBlobView(blob SecretBlob) map[string]any {
	return map[string]any{
		"ciphertext":        blob.Ciphertext,
		"iv":                blob.IV,
		"wrappedContentKey": blob.WrappedContentKey,
		"passphraseSalt":    blob.PassphraseSalt,
		"kdfIterations":     blob.KDFIterations,
	}
}

func writeSecretError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httpapi.WriteError(w, http.StatusNotFound, "not found")
	case errors.Is(err, ErrGone):
		httpapi.WriteError(w, http.StatusGone, "gone")
	default:
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
	}
}

package secrethide

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

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
	LoadOwned(ctx context.Context, token, userID string) (Secret, error)
	ListOwned(ctx context.Context, userID string) ([]Secret, error)
	RecordEmailSent(ctx context.Context, secretID, recipientEmail string) error
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
// /secrets and POST /secrets/{token}/send-email run behind authMiddleware;
// GET /secrets/{token} and POST /secrets/{token}/burn are unauthenticated
// and rate-limited per IP. A nil notifier is treated the same as
// NoopSecretReadNotifier. A nil linkMailer makes /send-email fail closed
// with 503 rather than silently succeeding or panicking.
func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, notifier secretReadNotifier, linkMailer secretLinkMailer) {
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

	mux.Handle("GET /secrets", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		secrets, err := service.ListOwned(r.Context(), principal.UserID)
		if err != nil {
			httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		httpapi.WriteJSON(w, http.StatusOK, secretHistoryView(secrets, time.Now().UTC()))
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

	mux.Handle("POST /secrets/{token}/send-email", authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := auth.PrincipalFromContext(r.Context())
		if !ok {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		input, err := decodeSendSecretLinkInput(r)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		secret, err := service.LoadOwned(r.Context(), r.PathValue("token"), principal.UserID)
		if err != nil {
			writeSecretError(w, err)
			return
		}

		if linkMailer == nil {
			httpapi.WriteError(w, http.StatusServiceUnavailable, "email delivery unavailable")
			return
		}

		if err := linkMailer.SendSecretLink(r.Context(), SecretLinkNotification{
			SecretID:       secret.ID,
			RecipientEmail: input.RecipientEmail,
			Token:          secret.Token,
			Fragment:       input.Fragment,
		}); err != nil {
			httpapi.WriteError(w, http.StatusBadGateway, "email delivery failed")
			return
		}

		// Best-effort: the email genuinely was sent, so a failure recording
		// the recipient in the micro-registry must never turn a successful
		// send into a failed response — only log it, mirroring mail.go's
		// safe-logging precedent (never the token, fragment, or link).
		if err := service.RecordEmailSent(r.Context(), secret.ID, input.RecipientEmail); err != nil {
			log.Printf("event=secret_email_recipient_record_failed secret_id=%q reason=%q", secret.ID, err.Error())
		}

		httpapi.WriteJSON(w, http.StatusOK, map[string]string{"status": "sent"})
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

// secretHistoryView builds the metadata-only micro-registry response for GET
// /secrets: one entry per secret with an id, timestamps, a computed status,
// and — a deliberate, narrow exception to this registry's "metadata only"
// rule — the most recent send-email recipient, since the caller already
// knows and typed that address themselves. It never includes the token,
// ciphertext, iv, or any key/passphrase-related field, since this registry
// must never be usable to re-fetch or re-derive a secret's content or link.
func secretHistoryView(secrets []Secret, now time.Time) []map[string]any {
	entries := make([]map[string]any, 0, len(secrets))
	for _, secret := range secrets {
		entries = append(entries, map[string]any{
			"id":          secret.ID,
			"createdAt":   secret.CreatedAt,
			"expiresAt":   secret.ExpiresAt,
			"status":      secretHistoryStatus(secret, now),
			"readAt":      secret.ReadAt,
			"sentToEmail": secret.SentToEmail,
		})
	}
	return entries
}

// secretHistoryStatus computes exactly one of "pending", "read", or
// "expired" from the stored status and expiry — "expired" is never stored,
// only derived when a still-"pending" row's expiry has passed.
func secretHistoryStatus(secret Secret, now time.Time) string {
	if secret.Status == "read" {
		return "read"
	}
	if now.After(secret.ExpiresAt) {
		return "expired"
	}
	return "pending"
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

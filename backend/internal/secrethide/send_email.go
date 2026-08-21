package secrethide

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"strings"
)

// maxFragmentBytes caps the accepted fragment size. Real fragments (a
// base64-encoded 256-bit content key, e.g. "k=AbC...") are well under a few
// hundred bytes; this cap is generous while still bounding how much text a
// caller can route through this endpoint into an outbound email.
const maxFragmentBytes = 4096

// allowedSendSecretLinkFields is the exhaustive set of keys POST
// /secrets/{token}/send-email accepts. Most importantly, there is no "link"
// or "url" field: the client can only ever supply the fragment portion, and
// the server always reconstructs the full link itself from its own trusted
// PublicBaseURL — this is what keeps the endpoint from being usable as a
// generic "send arbitrary text to arbitrary email" relay.
var allowedSendSecretLinkFields = map[string]struct{}{
	"recipientEmail": {},
	"fragment":       {},
}

// sendSecretLinkInput is the caller-supplied payload for POST
// /secrets/{token}/send-email. Fragment is the exact string that goes after
// "#" in the share URL, never including the "#" itself.
type sendSecretLinkInput struct {
	RecipientEmail string `json:"recipientEmail"`
	Fragment       string `json:"fragment,omitempty"`
}

// decodeSendSecretLinkInput enforces the field allow-list, validates
// recipientEmail is a well-formed address, and rejects a fragment
// containing CR/LF or exceeding maxFragmentBytes — all before the value is
// ever handed to the mailer.
func decodeSendSecretLinkInput(r *http.Request) (sendSecretLinkInput, error) {
	defer r.Body.Close()

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return sendSecretLinkInput{}, errors.New("read request body")
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return sendSecretLinkInput{}, errors.New("invalid request body")
	}

	for key := range raw {
		if _, ok := allowedSendSecretLinkFields[key]; !ok {
			return sendSecretLinkInput{}, errors.New("unsupported field: " + key)
		}
	}

	var input sendSecretLinkInput
	if err := json.Unmarshal(body, &input); err != nil {
		return sendSecretLinkInput{}, errors.New("invalid request body")
	}

	email := strings.TrimSpace(strings.ToLower(input.RecipientEmail))
	parsedEmail, err := mail.ParseAddress(email)
	if err != nil || parsedEmail.Address != email {
		return sendSecretLinkInput{}, errors.New("invalid recipient email")
	}
	input.RecipientEmail = email

	if strings.ContainsAny(input.Fragment, "\r\n") {
		return sendSecretLinkInput{}, errors.New("invalid fragment")
	}
	if len(input.Fragment) > maxFragmentBytes {
		return sendSecretLinkInput{}, errors.New("fragment exceeds maximum size")
	}

	return input, nil
}

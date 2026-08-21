package secrethide

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/url"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/mailer"
)

// SecretLinkNotification carries everything needed to compose and send the
// best-effort "send this secret link by email" message. This is a
// deliberate, explicit exception to this package's usual zero-knowledge
// rule: the server reconstructs and briefly holds the full shareable link
// (including the fragment) in memory for the duration of this one optional
// action, but — per the safe-logging rule mirrored from
// organizations.MailInvitationNotifier — the link and fragment are never
// logged or persisted, only ever handed to the mailer.
type SecretLinkNotification struct {
	SecretID       string
	RecipientEmail string
	Token          string
	Fragment       string
}

// secretLinkMailer is a narrow, consumer-defined port so this package
// depends only on the shape of notification it needs, not on
// internal/mailer directly at the handler boundary — mirroring
// organizations' invitationNotifier and this package's own
// secretReadNotifier port shapes.
type secretLinkMailer interface {
	SendSecretLink(ctx context.Context, notification SecretLinkNotification) error
}

// MailSecretLinkMailer is the concrete secretLinkMailer backed by
// internal/mailer. Only the concrete type and its constructor are exported
// so main can build one; the port stays unexported.
type MailSecretLinkMailer struct {
	mailer        mailer.Mailer
	publicBaseURL string
	logger        *log.Logger
}

// NewMailSecretLinkMailer constructs a MailSecretLinkMailer. publicBaseURL
// is the server's own trusted base URL (e.g. cfg.App.PublicBaseURL) — the
// link is always reconstructed from it server-side, never from
// caller-supplied input.
func NewMailSecretLinkMailer(m mailer.Mailer, publicBaseURL string, logOutput io.Writer) *MailSecretLinkMailer {
	return &MailSecretLinkMailer{
		mailer:        m,
		publicBaseURL: publicBaseURL,
		logger:        log.New(logOutput, "", 0),
	}
}

// SendSecretLink composes and sends the notification, logging only the
// recipient's email domain and success/failure — never the token, the
// fragment, or the reconstructed link.
func (n *MailSecretLinkMailer) SendSecretLink(ctx context.Context, notification SecretLinkNotification) error {
	message := composeSecretLinkMessage(n.publicBaseURL, notification)
	domain := emailDomain(notification.RecipientEmail)

	err := n.mailer.Send(ctx, message)
	if err != nil {
		if errors.Is(err, mailer.ErrDisabled) {
			n.logger.Printf("event=secret_link_email_failed secret_id=%q recipient_domain=%q reason=disabled", notification.SecretID, domain)
			return err
		}
		// err is safe to log: the only concrete Mailer implementation
		// (SMTPMailer) never wraps credentials, message bodies, or raw
		// server responses into it — see internal/mailer/smtp.go's
		// stageError, which only ever produces "smtp <stage> failed" or a
		// context error.
		n.logger.Printf("event=secret_link_email_failed secret_id=%q recipient_domain=%q reason=send_error detail=%q", notification.SecretID, domain, err.Error())
		return err
	}
	n.logger.Printf("event=secret_link_email_sent secret_id=%q recipient_domain=%q", notification.SecretID, domain)
	return nil
}

var secretLinkHTMLTemplate = template.Must(template.New("secretLink").Parse(`<!DOCTYPE html><html><body>
<p>Someone shared an encrypted secret with you. Open this link to view it (works once):</p>
<p><a href="{{.Link}}">{{.Link}}</a></p>
<p>If you weren't expecting this, you can ignore it.</p>
</body></html>`))

func composeSecretLinkMessage(publicBaseURL string, notification SecretLinkNotification) mailer.Message {
	link := secretLinkURL(publicBaseURL, notification.Token, notification.Fragment)

	text := fmt.Sprintf(
		"Someone shared an encrypted secret with you. Open this link to view it (works once):\n%s\n\nIf you weren't expecting this, you can ignore it.\n",
		link,
	)

	var htmlBuffer bytes.Buffer
	_ = secretLinkHTMLTemplate.Execute(&htmlBuffer, struct{ Link string }{Link: link})

	return mailer.Message{
		To:      []string{notification.RecipientEmail},
		Subject: "Someone shared an encrypted secret with you",
		Text:    text,
		HTML:    htmlBuffer.String(),
	}
}

// secretLinkURL builds {publicBaseURL}/s/{token}{#fragment}, using the
// server's own trusted publicBaseURL rather than any caller-supplied
// origin or path — this is what keeps the endpoint from being usable as a
// generic "send arbitrary text to arbitrary email" relay.
func secretLinkURL(publicBaseURL, token, fragment string) string {
	link := strings.TrimRight(publicBaseURL, "/") + "/s/" + url.PathEscape(token)
	if fragment != "" {
		link += "#" + fragment
	}
	return link
}

// emailDomain returns the domain portion of an email address for safe
// logging (never the local part, which can itself be identifying).
func emailDomain(email string) string {
	idx := strings.LastIndex(email, "@")
	if idx < 0 {
		return ""
	}
	return email[idx+1:]
}

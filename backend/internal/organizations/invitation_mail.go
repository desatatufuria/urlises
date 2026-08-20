package organizations

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/mailer"
)

// InvitationNotification carries everything needed to compose and send the
// best-effort invitation email, decoupled from the persisted Invitation's
// own JSON shape.
type InvitationNotification struct {
	InvitationID     string
	OrganizationID   string
	OrganizationName string
	InviterEmail     string
	InviterName      string
	InviteeEmail     string
	Role             string
	Token            string
	ExpiresAt        time.Time
}

// invitationNotifier is a narrow, consumer-defined port so this package
// depends only on the shape of notification it needs, not on internal/mailer
// directly at the handler boundary.
type invitationNotifier interface {
	NotifyInvitation(context.Context, InvitationNotification) error
}

// MailInvitationNotifier is the concrete invitationNotifier backed by
// internal/mailer. Only the concrete type and its constructor are exported
// so main can build one; the port stays unexported.
type MailInvitationNotifier struct {
	mailer        mailer.Mailer
	publicBaseURL string
	logger        *log.Logger
}

func NewMailInvitationNotifier(m mailer.Mailer, publicBaseURL string, logOutput io.Writer) *MailInvitationNotifier {
	return &MailInvitationNotifier{
		mailer:        m,
		publicBaseURL: publicBaseURL,
		logger:        log.New(logOutput, "", 0),
	}
}

func (n *MailInvitationNotifier) NotifyInvitation(ctx context.Context, notification InvitationNotification) error {
	message := composeInvitationMessage(n.publicBaseURL, notification)
	err := n.mailer.Send(ctx, message)
	if err != nil {
		if errors.Is(err, mailer.ErrDisabled) {
			n.logger.Printf("event=invitation_email_failed invitation_id=%q organization_id=%q reason=disabled", notification.InvitationID, notification.OrganizationID)
			return err
		}
		// err is safe to log: the only concrete Mailer implementation
		// (SMTPMailer) never wraps credentials, message bodies, or raw
		// server responses into it — see internal/mailer/smtp.go's
		// stageError, which only ever produces "smtp <stage> failed" or
		// a context error. This detail is what lets an operator tell a
		// dial failure from an auth failure from a TLS failure.
		n.logger.Printf("event=invitation_email_failed invitation_id=%q organization_id=%q reason=send_error detail=%q", notification.InvitationID, notification.OrganizationID, err.Error())
		return err
	}
	n.logger.Printf("event=invitation_email_sent invitation_id=%q organization_id=%q", notification.InvitationID, notification.OrganizationID)
	return nil
}

var invitationHTMLTemplate = template.Must(template.New("invitation").Parse(`<!DOCTYPE html><html><body>
<p>{{.Inviter}} invited you to join <strong>{{.Org}}</strong> on URLises as {{.Role}}.</p>
<p><a href="{{.AcceptURL}}">Accept the invitation</a></p>
<p>This invitation expires on {{.Expiry}}, 7 days after it was sent.
If you did not expect this invitation you can ignore this message.</p>
</body></html>`))

func composeInvitationMessage(publicBaseURL string, notification InvitationNotification) mailer.Message {
	org := sanitizeHeaderValue(notification.OrganizationName)
	inviter := inviterIdentity(notification.InviterName, notification.InviterEmail)
	role := roleDescription(notification.Role)
	expiry := notification.ExpiresAt.UTC().Format("2 January 2006 15:04 UTC")
	acceptURL := invitationAcceptURL(publicBaseURL, notification.Token, notification.InviteeEmail)

	subject := fmt.Sprintf("You are invited to join %s on URLises", org)

	text := fmt.Sprintf(
		"%s invited you to join %s on URLises as %s.\n\nAccept the invitation:\n%s\n\nThis invitation expires on %s, 7 days after it was sent.\nIf you did not expect this invitation you can ignore this message.\n",
		inviter, org, role, acceptURL, expiry,
	)

	var htmlBuffer bytes.Buffer
	_ = invitationHTMLTemplate.Execute(&htmlBuffer, struct {
		Inviter, Org, Role, AcceptURL, Expiry string
	}{Inviter: inviter, Org: org, Role: role, AcceptURL: acceptURL, Expiry: expiry})

	return mailer.Message{
		To:      []string{notification.InviteeEmail},
		Subject: subject,
		Text:    text,
		HTML:    htmlBuffer.String(),
	}
}

// invitationAcceptURL builds {PUBLIC_BASE_URL}/invitations/{token}?email={invitee}.
func invitationAcceptURL(baseURL, token, inviteeEmail string) string {
	return strings.TrimRight(baseURL, "/") + "/invitations/" + url.PathEscape(token) +
		"?" + url.Values{"email": {inviteeEmail}}.Encode()
}

func inviterIdentity(name, email string) string {
	if name != "" {
		return fmt.Sprintf("%s (%s)", name, email)
	}
	return email
}

func roleDescription(role string) string {
	switch role {
	case "owner":
		return "an owner"
	case "admin":
		return "an admin"
	case "member":
		return "a member"
	default:
		return role
	}
}

var invitationWhitespaceCollapse = regexp.MustCompile(`\s+`)

// sanitizeHeaderValue strips CR/LF (organization names are free user input,
// and mailer's safeHeader rejects any CR/LF in the subject) and collapses
// the remaining whitespace, so a malicious org name degrades to readable
// text instead of a silently failed send.
func sanitizeHeaderValue(value string) string {
	stripped := strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
	return strings.TrimSpace(invitationWhitespaceCollapse.ReplaceAllString(stripped, " "))
}

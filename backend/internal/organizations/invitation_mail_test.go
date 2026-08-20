package organizations

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/mailer"
)

type fakeMailer struct {
	message mailer.Message
	err     error
	calls   int
}

func (f *fakeMailer) Send(_ context.Context, message mailer.Message) error {
	f.calls++
	f.message = message
	return f.err
}

func baseInvitationNotification() InvitationNotification {
	return InvitationNotification{
		InvitationID:     "invite-1",
		OrganizationID:   "org-1",
		OrganizationName: "Acme",
		InviterEmail:     "owner@acme.com",
		InviterName:      "",
		InviteeEmail:     "invitee@example.com",
		Role:             "admin",
		Token:            "abc123",
		ExpiresAt:        time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC),
	}
}

func TestNotifyInvitationBuildsExactAcceptURLFromSpecScenario(t *testing.T) {
	fake := &fakeMailer{}
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &bytes.Buffer{})

	notification := InvitationNotification{
		InvitationID:     "invite-1",
		OrganizationID:   "org-1",
		OrganizationName: "Acme",
		InviterEmail:     "owner@acme.com",
		InviteeEmail:     "invitee@example.com",
		Role:             "admin",
		Token:            "abc123",
		ExpiresAt:        time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC),
	}

	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("mailer calls = %d, want 1", fake.calls)
	}

	wantURL := "https://admin.example.com/invitations/abc123?email=invitee%40example.com"
	if !strings.Contains(fake.message.Text, wantURL) {
		t.Fatalf("text body = %q, want to contain accept URL %q", fake.message.Text, wantURL)
	}
	if !strings.Contains(fake.message.HTML, wantURL) {
		t.Fatalf("html body = %q, want to contain accept URL %q", fake.message.HTML, wantURL)
	}
}

func TestNotifyInvitationMessageContainsRequiredFieldsInBothBodies(t *testing.T) {
	fake := &fakeMailer{}
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &bytes.Buffer{})

	notification := baseInvitationNotification()
	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}

	for _, body := range []string{fake.message.Text, fake.message.HTML} {
		if !strings.Contains(body, "Acme") {
			t.Fatalf("body %q missing organization name", body)
		}
		if !strings.Contains(body, "owner@acme.com") {
			t.Fatalf("body %q missing inviter identity", body)
		}
		if !strings.Contains(body, "admin") {
			t.Fatalf("body %q missing role", body)
		}
		if !strings.Contains(body, "1 January 2026") {
			t.Fatalf("body %q missing expiry date", body)
		}
	}
	if fake.message.Subject == "" {
		t.Fatal("subject is empty")
	}
	if len(fake.message.To) != 1 || fake.message.To[0] != "invitee@example.com" {
		t.Fatalf("To = %#v, want [invitee@example.com]", fake.message.To)
	}
}

func TestNotifyInvitationMessageWithInviterNameShowsNameAndEmail(t *testing.T) {
	fake := &fakeMailer{}
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &bytes.Buffer{})

	notification := baseInvitationNotification()
	notification.InviterName = "Ada Lovelace"
	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}

	if !strings.Contains(fake.message.Text, "Ada Lovelace") {
		t.Fatalf("text body = %q, want inviter name present", fake.message.Text)
	}
	if !strings.Contains(fake.message.Text, "owner@acme.com") {
		t.Fatalf("text body = %q, want inviter email present alongside name", fake.message.Text)
	}
}

// 3.2 RED (subject-line correctness, not polish): an organization name
// containing CR/LF must still produce a mailer-acceptable subject.
func TestNotifyInvitationSanitizesCRLFInOrganizationNameForSubject(t *testing.T) {
	fake := &fakeMailer{}
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &bytes.Buffer{})

	notification := baseInvitationNotification()
	notification.OrganizationName = "Acme\r\nBcc: attacker@evil.example"

	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("mailer calls = %d, want 1", fake.calls)
	}
	if strings.ContainsAny(fake.message.Subject, "\r\n") {
		t.Fatalf("subject = %q, must not contain CR/LF (mailer's safeHeader would reject it)", fake.message.Subject)
	}
	if !strings.Contains(fake.message.Subject, "Acme") {
		t.Fatalf("subject = %q, want to still contain the sanitized organization name", fake.message.Subject)
	}
}

func TestNotifyInvitationCollapsesWhitespaceInOrganizationName(t *testing.T) {
	fake := &fakeMailer{}
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &bytes.Buffer{})

	notification := baseInvitationNotification()
	notification.OrganizationName = "Acme   Corp\r\n\r\nHQ"

	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}
	if strings.ContainsAny(fake.message.Subject, "\r\n") {
		t.Fatalf("subject = %q, must not contain CR/LF", fake.message.Subject)
	}
	if strings.Contains(fake.message.Subject, "  ") {
		t.Fatalf("subject = %q, whitespace must be collapsed", fake.message.Subject)
	}
}

// 3.3 RED: an organization name containing markup is HTML-escaped in the
// rendered body.
func TestNotifyInvitationEscapesHTMLInOrganizationName(t *testing.T) {
	fake := &fakeMailer{}
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &bytes.Buffer{})

	notification := baseInvitationNotification()
	notification.OrganizationName = "<script>alert(1)</script>"

	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}
	if strings.Contains(fake.message.HTML, "<script>alert(1)</script>") {
		t.Fatalf("html body = %q, organization name must be HTML-escaped", fake.message.HTML)
	}
	if !strings.Contains(fake.message.HTML, "&lt;script&gt;") {
		t.Fatalf("html body = %q, want escaped organization name", fake.message.HTML)
	}
}

// 3.3 RED: ErrDisabled is logged with reason=disabled and the log buffer
// never contains the token, invitee address, or accept URL.
func TestNotifyInvitationLogsDisabledWithoutLeakingSecrets(t *testing.T) {
	fake := &fakeMailer{err: mailer.ErrDisabled}
	var logBuffer bytes.Buffer
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &logBuffer)

	notification := baseInvitationNotification()
	notification.Token = "super-secret-token"
	notification.InviteeEmail = "victim@example.com"

	err := notifier.NotifyInvitation(context.Background(), notification)
	if !errors.Is(err, mailer.ErrDisabled) {
		t.Fatalf("NotifyInvitation() error = %v, want ErrDisabled", err)
	}

	logOutput := logBuffer.String()
	if !strings.Contains(logOutput, "event=invitation_email_failed") {
		t.Fatalf("log = %q, want event=invitation_email_failed", logOutput)
	}
	if !strings.Contains(logOutput, "reason=disabled") {
		t.Fatalf("log = %q, want reason=disabled", logOutput)
	}
	if !strings.Contains(logOutput, notification.InvitationID) {
		t.Fatalf("log = %q, want invitation id present", logOutput)
	}
	if strings.Contains(logOutput, notification.Token) {
		t.Fatalf("log = %q, must not leak the invitation token", logOutput)
	}
	if strings.Contains(logOutput, notification.InviteeEmail) {
		t.Fatalf("log = %q, must not leak the invitee email", logOutput)
	}
	if strings.Contains(logOutput, "/invitations/") {
		t.Fatalf("log = %q, must not leak the accept URL", logOutput)
	}
}

// Triangulation: a generic send error logs reason=send_error, distinct from
// the disabled-mail case above.
func TestNotifyInvitationLogsSendErrorReason(t *testing.T) {
	fake := &fakeMailer{err: errors.New("connection refused")}
	var logBuffer bytes.Buffer
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &logBuffer)

	notification := baseInvitationNotification()
	err := notifier.NotifyInvitation(context.Background(), notification)
	if err == nil {
		t.Fatal("NotifyInvitation() error = nil, want send failure")
	}

	logOutput := logBuffer.String()
	if !strings.Contains(logOutput, "event=invitation_email_failed") {
		t.Fatalf("log = %q, want event=invitation_email_failed", logOutput)
	}
	if !strings.Contains(logOutput, "reason=send_error") {
		t.Fatalf("log = %q, want reason=send_error", logOutput)
	}
}

// Triangulation: a successful send logs event=invitation_email_sent.
func TestNotifyInvitationLogsSuccess(t *testing.T) {
	fake := &fakeMailer{}
	var logBuffer bytes.Buffer
	notifier := NewMailInvitationNotifier(fake, "https://admin.example.com", &logBuffer)

	notification := baseInvitationNotification()
	if err := notifier.NotifyInvitation(context.Background(), notification); err != nil {
		t.Fatalf("NotifyInvitation() error = %v", err)
	}

	logOutput := logBuffer.String()
	if !strings.Contains(logOutput, "event=invitation_email_sent") {
		t.Fatalf("log = %q, want event=invitation_email_sent", logOutput)
	}
	if !strings.Contains(logOutput, notification.InvitationID) {
		t.Fatalf("log = %q, want invitation id present", logOutput)
	}
}

func TestInvitationAcceptURLEscapesToken(t *testing.T) {
	got := invitationAcceptURL("https://admin.example.com/", "tok en", "invitee@example.com")
	want := "https://admin.example.com/invitations/tok%20en?email=invitee%40example.com"
	if got != want {
		t.Fatalf("invitationAcceptURL() = %q, want %q", got, want)
	}
}

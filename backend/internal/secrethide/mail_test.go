package secrethide

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/furia/shared-bookmark-sync/backend/internal/mailer"
)

type fakeSecretMailer struct {
	message mailer.Message
	err     error
	calls   int
}

func (f *fakeSecretMailer) Send(_ context.Context, message mailer.Message) error {
	f.calls++
	f.message = message
	return f.err
}

func baseSecretLinkNotification() SecretLinkNotification {
	return SecretLinkNotification{
		SecretID:       "secret-1",
		RecipientEmail: "friend@example.com",
		Token:          "tok123",
		Fragment:       "k=AbCdEf",
	}
}

// --- Task: link composition (never a client-asserted origin/path) ---

func TestSendSecretLinkBuildsLinkFromTrustedPublicBaseURLTokenAndFragment(t *testing.T) {
	fake := &fakeSecretMailer{}
	notifier := NewMailSecretLinkMailer(fake, "https://app.example.com", &bytes.Buffer{})

	if err := notifier.SendSecretLink(context.Background(), baseSecretLinkNotification()); err != nil {
		t.Fatalf("SendSecretLink() error = %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("mailer calls = %d, want 1", fake.calls)
	}

	wantLink := "https://app.example.com/s/tok123#k=AbCdEf"
	if !strings.Contains(fake.message.Text, wantLink) {
		t.Fatalf("text body = %q, want to contain link %q", fake.message.Text, wantLink)
	}
	if !strings.Contains(fake.message.HTML, wantLink) {
		t.Fatalf("html body = %q, want to contain link %q", fake.message.HTML, wantLink)
	}
	if len(fake.message.To) != 1 || fake.message.To[0] != "friend@example.com" {
		t.Fatalf("To = %#v, want [friend@example.com]", fake.message.To)
	}
	if fake.message.Subject == "" {
		t.Fatal("subject is empty")
	}
}

func TestSendSecretLinkOmitsFragmentSeparatorWhenFragmentEmpty(t *testing.T) {
	fake := &fakeSecretMailer{}
	notifier := NewMailSecretLinkMailer(fake, "https://app.example.com", &bytes.Buffer{})

	notification := baseSecretLinkNotification()
	notification.Fragment = ""
	if err := notifier.SendSecretLink(context.Background(), notification); err != nil {
		t.Fatalf("SendSecretLink() error = %v", err)
	}

	wantLink := "https://app.example.com/s/tok123"
	if !strings.Contains(fake.message.Text, wantLink) {
		t.Fatalf("text body = %q, want to contain link %q", fake.message.Text, wantLink)
	}
	if strings.Contains(fake.message.Text, wantLink+"#") {
		t.Fatalf("text body = %q, must not contain a trailing # with no fragment", fake.message.Text)
	}
}

func TestSecretLinkURLEscapesToken(t *testing.T) {
	got := secretLinkURL("https://app.example.com/", "tok en", "")
	want := "https://app.example.com/s/tok%20en"
	if got != want {
		t.Fatalf("secretLinkURL() = %q, want %q", got, want)
	}
}

// --- Task: safe logging (never log/persist the full link or fragment) ---

func TestSendSecretLinkLogsRecipientDomainOnlyOnSuccess(t *testing.T) {
	fake := &fakeSecretMailer{}
	var logBuffer bytes.Buffer
	notifier := NewMailSecretLinkMailer(fake, "https://app.example.com", &logBuffer)

	notification := baseSecretLinkNotification()
	if err := notifier.SendSecretLink(context.Background(), notification); err != nil {
		t.Fatalf("SendSecretLink() error = %v", err)
	}

	logOutput := logBuffer.String()
	if !strings.Contains(logOutput, "event=secret_link_email_sent") {
		t.Fatalf("log = %q, want event=secret_link_email_sent", logOutput)
	}
	if !strings.Contains(logOutput, notification.SecretID) {
		t.Fatalf("log = %q, want secret id present", logOutput)
	}
	if !strings.Contains(logOutput, "example.com") {
		t.Fatalf("log = %q, want recipient domain present", logOutput)
	}
	if strings.Contains(logOutput, "friend@") {
		t.Fatalf("log = %q, must not leak the recipient's local part", logOutput)
	}
	if strings.Contains(logOutput, notification.Fragment) {
		t.Fatalf("log = %q, must not leak the fragment", logOutput)
	}
	if strings.Contains(logOutput, "/s/"+notification.Token) {
		t.Fatalf("log = %q, must not leak the reconstructed link", logOutput)
	}
}

func TestSendSecretLinkLogsSendErrorStageWithoutLeakingLinkOrFragment(t *testing.T) {
	fake := &fakeSecretMailer{err: errors.New("smtp dial failed")}
	var logBuffer bytes.Buffer
	notifier := NewMailSecretLinkMailer(fake, "https://app.example.com", &logBuffer)

	notification := baseSecretLinkNotification()
	err := notifier.SendSecretLink(context.Background(), notification)
	if err == nil {
		t.Fatal("SendSecretLink() error = nil, want send failure")
	}

	logOutput := logBuffer.String()
	if !strings.Contains(logOutput, "event=secret_link_email_failed") {
		t.Fatalf("log = %q, want event=secret_link_email_failed", logOutput)
	}
	if !strings.Contains(logOutput, "reason=send_error") {
		t.Fatalf("log = %q, want reason=send_error", logOutput)
	}
	// Safe to log: the only concrete Mailer implementation (SMTPMailer) never
	// wraps credentials, message bodies, or raw server responses into its
	// error (see internal/mailer/smtp.go's stageError).
	if !strings.Contains(logOutput, `detail="smtp dial failed"`) {
		t.Fatalf("log = %q, want detail with the underlying stage error", logOutput)
	}
	if strings.Contains(logOutput, notification.Fragment) {
		t.Fatalf("log = %q, must not leak the fragment", logOutput)
	}
	if strings.Contains(logOutput, "/s/"+notification.Token) {
		t.Fatalf("log = %q, must not leak the reconstructed link", logOutput)
	}
	if strings.Contains(logOutput, "friend@") {
		t.Fatalf("log = %q, must not leak the recipient's local part", logOutput)
	}
}

func TestSendSecretLinkLogsDisabledReason(t *testing.T) {
	fake := &fakeSecretMailer{err: mailer.ErrDisabled}
	var logBuffer bytes.Buffer
	notifier := NewMailSecretLinkMailer(fake, "https://app.example.com", &logBuffer)

	notification := baseSecretLinkNotification()
	err := notifier.SendSecretLink(context.Background(), notification)
	if !errors.Is(err, mailer.ErrDisabled) {
		t.Fatalf("SendSecretLink() error = %v, want ErrDisabled", err)
	}

	logOutput := logBuffer.String()
	if !strings.Contains(logOutput, "reason=disabled") {
		t.Fatalf("log = %q, want reason=disabled", logOutput)
	}
}

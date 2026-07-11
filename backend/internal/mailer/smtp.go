package mailer

import (
	"context"
	"crypto/tls"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
)

type dialContext func(context.Context, string, string) (net.Conn, error)

type SMTPMailer struct {
	config config.MailConfig
	dial   dialContext
}

func NewSMTP(cfg config.MailConfig) Mailer {
	return newSMTP(cfg, (&net.Dialer{}).DialContext)
}

func newSMTP(cfg config.MailConfig, dial dialContext) *SMTPMailer {
	return &SMTPMailer{config: cfg, dial: dial}
}

func (m *SMTPMailer) Send(ctx context.Context, message Message) error {
	if !m.config.Enabled {
		return ErrDisabled
	}
	if err := m.config.Validate(); err != nil {
		return err
	}
	body, fromName, replyTo, err := m.compose(message)
	if err != nil {
		return err
	}

	deadline := time.Now().Add(m.config.Timeout)
	if callerDeadline, ok := ctx.Deadline(); ok && callerDeadline.Before(deadline) {
		deadline = callerDeadline
	}
	operationCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	conn, err := m.dial(operationCtx, "tcp", net.JoinHostPort(m.config.Host, strconv.Itoa(m.config.Port)))
	if err != nil {
		return stageError(operationCtx, "dial")
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-operationCtx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()

	client, err := m.client(operationCtx, conn)
	if err != nil {
		return stageError(operationCtx, "tls")
	}
	defer client.Close()
	if m.config.TLSMode == config.TLSModeStartTLS {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return stageError(operationCtx, "tls")
		}
		if err := client.StartTLS(&tls.Config{ServerName: m.config.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return stageError(operationCtx, "tls")
		}
	}
	if m.config.AuthMode == config.AuthModePlain {
		if err := client.Auth(smtp.PlainAuth("", m.config.Username, m.config.Password, m.config.Host)); err != nil {
			return stageError(operationCtx, "auth")
		}
	}
	if err := client.Mail(m.config.FromAddress); err != nil {
		return stageError(operationCtx, "data")
	}
	for _, recipient := range message.To {
		if err := client.Rcpt(recipient); err != nil {
			return stageError(operationCtx, "data")
		}
	}
	writer, err := client.Data()
	if err != nil {
		return stageError(operationCtx, "data")
	}
	if _, err := writer.Write(body); err != nil {
		return stageError(operationCtx, "data")
	}
	if err := writer.Close(); err != nil {
		return stageError(operationCtx, "data")
	}
	if err := client.Quit(); err != nil {
		return stageError(operationCtx, "data")
	}
	_ = fromName
	_ = replyTo
	return nil
}

func (m *SMTPMailer) client(ctx context.Context, conn net.Conn) (*smtp.Client, error) {
	if m.config.TLSMode == config.TLSModeTLS {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: m.config.Host, MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		return smtp.NewClient(tlsConn, m.config.Host)
	}
	return smtp.NewClient(conn, m.config.Host)
}

func (m *SMTPMailer) compose(message Message) ([]byte, string, string, error) {
	if len(message.To) == 0 || !safeHeader(message.Subject) || message.Text == "" || message.HTML == "" {
		return nil, "", "", fmt.Errorf("invalid mail message")
	}
	for _, recipient := range message.To {
		if !mailbox(recipient) {
			return nil, "", "", fmt.Errorf("invalid mail message")
		}
	}
	fromName := m.config.FromDisplayName
	if message.DisplayName != "" {
		fromName = message.DisplayName
	}
	replyTo := m.config.ReplyTo
	if message.ReplyTo != "" {
		replyTo = message.ReplyTo
	}
	if !safeHeader(fromName) || !mailbox(replyTo) {
		return nil, "", "", fmt.Errorf("invalid mail message")
	}

	var output strings.Builder
	boundary := "smtp-poc-boundary"
	output.WriteString("From: " + (&mail.Address{Name: fromName, Address: m.config.FromAddress}).String() + "\r\n")
	output.WriteString("To: " + strings.Join(message.To, ", ") + "\r\n")
	output.WriteString("Reply-To: " + replyTo + "\r\n")
	output.WriteString("Subject: " + mime.QEncoding.Encode("UTF-8", message.Subject) + "\r\n")
	output.WriteString("MIME-Version: 1.0\r\n")
	output.WriteString("Content-Type: multipart/alternative; boundary=" + boundary + "\r\n\r\n")
	writer := multipart.NewWriter(&output)
	_ = writer.SetBoundary(boundary)
	for _, part := range []struct{ contentType, content string }{{"text/plain; charset=UTF-8", message.Text}, {"text/html; charset=UTF-8", message.HTML}} {
		headers := make(map[string][]string)
		headers["Content-Type"] = []string{part.contentType}
		headers["Content-Transfer-Encoding"] = []string{"quoted-printable"}
		partWriter, err := writer.CreatePart(headers)
		if err != nil {
			return nil, "", "", fmt.Errorf("compose mail")
		}
		quoted := quotedprintable.NewWriter(partWriter)
		_, _ = quoted.Write([]byte(part.content))
		_ = quoted.Close()
	}
	_ = writer.Close()
	return []byte(output.String()), fromName, replyTo, nil
}

func mailbox(value string) bool {
	if strings.ContainsAny(value, "\r\n") {
		return false
	}
	address, err := mail.ParseAddress(value)
	return err == nil && address.Address == value
}

func safeHeader(value string) bool {
	return strings.TrimSpace(value) != "" && !strings.ContainsAny(value, "\r\n")
}

func stageError(ctx context.Context, stage string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return fmt.Errorf("smtp %s failed", stage)
}

package mailer

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
)

func testConfig() config.MailConfig {
	return config.MailConfig{Enabled: true, Host: "127.0.0.1", Port: 2525, Timeout: time.Second, TLSMode: config.TLSModeNone, AuthMode: config.AuthModeNone, FromAddress: "mail@example.test", FromDisplayName: "Platform", ReplyTo: "support@example.test"}
}

func validMessage() Message {
	return Message{To: []string{"person@example.test"}, Subject: "Hello ✓", Text: "plain text", HTML: "<p>html</p>"}
}

func TestSMTPPreflight(t *testing.T) {
	cases := []struct {
		name string
		cfg  config.MailConfig
		msg  Message
		want error
	}{
		{"disabled", config.MailConfig{}, validMessage(), ErrDisabled},
		{"missing alternative", testConfig(), Message{To: []string{"person@example.test"}, Subject: "hello", Text: "plain"}, nil},
		{"unsafe subject", testConfig(), Message{To: []string{"person@example.test"}, Subject: "hello\r\nBcc: x", Text: "plain", HTML: "<p>html</p>"}, nil},
		{"invalid recipient", testConfig(), Message{To: []string{"bad"}, Subject: "hello", Text: "plain", HTML: "<p>html</p>"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dialed := false
			m := newSMTP(tc.cfg, func(context.Context, string, string) (net.Conn, error) {
				dialed = true
				return nil, errors.New("unexpected")
			})
			err := m.Send(context.Background(), tc.msg)
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("Send() error = %v, want %v", err, tc.want)
			}
			if tc.want == nil && err == nil {
				t.Fatal("Send() succeeded for invalid message")
			}
			if dialed {
				t.Fatal("Send() dialed before validation")
			}
		})
	}
}

func TestSMTPMIMEAndFallback(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	received := make(chan string, 1)
	go acceptSMTP(t, listener, received)
	cfg := testConfig()
	cfg.Host = "127.0.0.1"
	cfg.Port = listener.Addr().(*net.TCPAddr).Port
	if err := NewSMTP(cfg).Send(context.Background(), validMessage()); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	message := <-received
	for _, want := range []string{"multipart/alternative", "text/plain; charset=UTF-8", "text/html; charset=UTF-8", "quoted-printable", "From: \"Platform\" <mail@example.test>", "Subject: =?UTF-8?"} {
		if !strings.Contains(message, want) {
			t.Errorf("message missing %q: %s", want, message)
		}
	}
}

func TestSMTPIdentityOverrideAndSafeStageError(t *testing.T) {
	cfg := testConfig()
	m := newSMTP(cfg, func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("password=secret")
	})
	err := m.Send(context.Background(), validMessage())
	if err == nil || strings.Contains(err.Error(), "secret") || err.Error() != "smtp dial failed" {
		t.Fatalf("Send() error = %v, want sanitized dial error", err)
	}

	message := validMessage()
	message.DisplayName = "Organization"
	message.ReplyTo = "org@example.test"
	body, _, _, err := m.compose(message)
	if err != nil {
		t.Fatalf("compose() error = %v", err)
	}
	for _, want := range []string{"From: \"Organization\" <mail@example.test>", "Reply-To: org@example.test"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("message missing %q", want)
		}
	}
}

func TestSMTPCancellationClosesConnection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	closed := make(chan struct{})
	go func() {
		conn, _ := listener.Accept()
		if conn != nil {
			defer conn.Close()
			_, _ = conn.Write([]byte("220 test\r\n"))
			buffer := make([]byte, 64)
			_, _ = conn.Read(buffer)
			<-time.After(time.Second)
			close(closed)
		}
	}()
	cfg := testConfig()
	cfg.Port = listener.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	err = NewSMTP(cfg).Send(ctx, validMessage())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Send() error = %v, want canceled", err)
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection was not closed")
	}
}

func acceptSMTP(t *testing.T, listener net.Listener, received chan<- string) {
	t.Helper()
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("220 test\r\n"))
	buffer := make([]byte, 8192)
	var all strings.Builder
	for {
		n, err := conn.Read(buffer)
		if err != nil {
			return
		}
		line := string(buffer[:n])
		all.WriteString(line)
		switch {
		case strings.HasPrefix(line, "EHLO"):
			_, _ = conn.Write([]byte("250 test\r\n"))
		case strings.HasPrefix(line, "MAIL FROM"), strings.HasPrefix(line, "RCPT TO"):
			_, _ = conn.Write([]byte("250 ok\r\n"))
		case strings.HasPrefix(line, "DATA"):
			_, _ = conn.Write([]byte("354 send\r\n"))
		case strings.Contains(line, "\r\n.\r\n"):
			_, _ = conn.Write([]byte("250 queued\r\n"))
		case strings.HasPrefix(line, "QUIT"):
			_, _ = conn.Write([]byte("221 bye\r\n"))
			received <- all.String()
			return
		}
	}
}

package mailer

import (
	"context"
	"net"
	"os"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
)

func TestMailpitSmoke(t *testing.T) {
	if os.Getenv("MAILPIT_SMOKE_TEST") != "1" {
		t.Skip("set MAILPIT_SMOKE_TEST=1 to run Mailpit smoke test")
	}
	host, portText, err := net.SplitHostPort(os.Getenv("MAILPIT_SMOKE_ADDR"))
	if err != nil {
		t.Fatalf("MAILPIT_SMOKE_ADDR: %v", err)
	}
	port, err := net.LookupPort("tcp", portText)
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	cfg.Host, cfg.Port = host, port
	cfg.Timeout = 5 * time.Second
	cfg.TLSMode = config.TLSModeNone
	if err := NewSMTP(cfg).Send(context.Background(), validMessage()); err != nil {
		t.Fatalf("Mailpit send: %v", err)
	}
}

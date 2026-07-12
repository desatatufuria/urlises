package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
)

func TestWSTicketsPostgres(t *testing.T) {
	ctx, pool := refreshTestPool(t)
	if err := database.Migrate(ctx, pool, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	s := NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: time.Minute, ClientIDHeader: "X-Client-Id"})
	session, err := s.Register(ctx, RegisterInput{Email: "ticket@example.test", Password: "password"}, "ticket-client")
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.AuthenticateToken(ctx, session.AccessToken, "ticket-client")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("hash expiry and one use", func(t *testing.T) {
		issued, err := s.CreateWSTicket(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256([]byte(issued.Ticket))
		var stored []byte
		var created, expires time.Time
		if err := pool.QueryRow(ctx, `SELECT ticket_hash,created_at,expires_at FROM ws_tickets WHERE ticket_hash=$1`, h[:]).Scan(&stored, &created, &expires); err != nil {
			t.Fatal(err)
		}
		if string(stored) != string(h[:]) || expires.Sub(created) != 30*time.Second {
			t.Fatal("ticket persistence")
		}
		got, err := s.ConsumeWSTicket(ctx, issued.Ticket)
		if err != nil || got.UserID != p.UserID || got.ClientID != p.ClientID {
			t.Fatal("consume binding")
		}
		if _, err := s.ConsumeWSTicket(ctx, issued.Ticket); !errors.Is(err, ErrUnauthorized) {
			t.Fatal("reuse accepted")
		}
	})
	t.Run("concurrent only one wins", func(t *testing.T) {
		issued, _ := s.CreateWSTicket(ctx, p)
		var wg sync.WaitGroup
		wins := 0
		var mu sync.Mutex
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, e := s.ConsumeWSTicket(context.Background(), issued.Ticket); e == nil {
					mu.Lock()
					wins++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if wins != 1 {
			t.Fatalf("wins=%d", wins)
		}
	})
	for _, ticket := range []string{"", "unknown"} {
		if _, err := s.ConsumeWSTicket(ctx, ticket); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("invalid ticket: %v", err)
		}
	}
	t.Run("expired and client mismatch are unauthorized", func(t *testing.T) {
		issued, _ := s.CreateWSTicket(ctx, p)
		hash := sha256.Sum256([]byte(issued.Ticket))
		if _, err := pool.Exec(ctx, `UPDATE ws_tickets SET created_at=NOW()-INTERVAL '31 seconds', expires_at=NOW()-INTERVAL '1 second' WHERE ticket_hash=$1`, hash[:]); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ConsumeWSTicket(ctx, issued.Ticket); !errors.Is(err, ErrUnauthorized) {
			t.Fatal(err)
		}
		if _, err := s.CreateWSTicket(ctx, Principal{UserID: p.UserID, ClientID: "other"}); !errors.Is(err, ErrUnauthorized) {
			t.Fatal(err)
		}
	})
	t.Run("endpoint authenticates caches safely and hides failures", func(t *testing.T) {
		mux := http.NewServeMux()
		RegisterRoutes(mux, s, nil)
		req := func(token, client string) *httptest.ResponseRecorder {
			r := httptest.NewRequest(http.MethodPost, "/auth/ws-ticket", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("X-Client-Id", client)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			return w
		}
		for _, w := range []*httptest.ResponseRecorder{req("", "ticket-client"), req("invalid", "ticket-client"), req(session.AccessToken, "")} {
			if w.Code != 401 || strings.Contains(w.Body.String(), session.AccessToken) {
				t.Fatalf("auth=%d %s", w.Code, w.Body.String())
			}
		}
		w := req(session.AccessToken, "ticket-client")
		if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("Pragma") != "no-cache" {
			t.Fatalf("valid=%d", w.Code)
		}
		var v WSTicket
		if json.NewDecoder(w.Body).Decode(&v) != nil || v.Ticket == "" || v.ExpiresAt.IsZero() {
			t.Fatal("ticket response")
		}
		if _, err := pool.Exec(ctx, `DROP TABLE ws_tickets`); err != nil {
			t.Fatal(err)
		}
		w = req(session.AccessToken, "ticket-client")
		if w.Code != 503 || strings.Contains(w.Body.String(), "ws_tickets") {
			t.Fatalf("outage=%d %s", w.Code, w.Body.String())
		}
	})
}

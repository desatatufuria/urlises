package wsapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/config"
	"github.com/furia/shared-bookmark-sync/backend/internal/database"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

type testCursors struct{}

func (testCursors) CurrentCursor(context.Context, string) (int64, error) { return 0, nil }

func TestTicketWebSocketUpgradePostgres(t *testing.T) {
	ctx, pool := websocketTestPool(t)
	authService := auth.NewService(pool, config.AuthConfig{JWTSecret: []byte("server-secret"), TokenTTL: time.Minute, ClientIDHeader: "X-Client-Id"})
	session, err := authService.Register(ctx, auth.RegisterInput{Email: "socket@example.test", Password: "password"}, "socket-client")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := authService.AuthenticateToken(ctx, session.AccessToken, "socket-client")
	if err != nil {
		t.Fatal(err)
	}
	var organizationID string
	if err := pool.QueryRow(ctx, `INSERT INTO organizations(name) VALUES('Sockets') RETURNING id`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')`, organizationID, principal.UserID); err != nil {
		t.Fatal(err)
	}
	workspace, err := workspaces.NewService(pool, nil, activity.NewService(pool)).Create(ctx, principal.UserID, organizationID, workspaces.CreateWorkspaceInput{Name: "Sockets", Type: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, authService, workspaces.NewService(pool, nil, activity.NewService(pool)), testCursors{}, NewHub())
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	dial := func(endpoint, protocol string, legacy bool) (*websocket.Conn, *http.Response, error) {
		d := websocket.Dialer{}
		if protocol != "" {
			d.Subprotocols = []string{protocol}
		}
		header := http.Header{}
		if legacy {
			header.Set("Authorization", "Bearer "+session.AccessToken)
			header.Set("X-Client-Id", "socket-client")
		}
		return d.Dial(endpoint+"?workspaceId="+workspace.WorkspaceID, header)
	}
	issue := func() string {
		ticket, err := authService.CreateWSTicket(ctx, principal)
		if err != nil {
			t.Fatal(err)
		}
		return ticket.Ticket
	}
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/sync/ws"

	t.Run("selects the exact ticket protocol and does not put it in the URL", func(t *testing.T) {
		ticket := issue()
		connection, response, err := dial(wsURL, ticketProtocolPrefix+ticket, false)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer connection.Close()
		if response.Header.Get("Sec-WebSocket-Protocol") != ticketProtocolPrefix+ticket || connection.Subprotocol() != ticketProtocolPrefix+ticket {
			t.Fatalf("selected protocol = %q", connection.Subprotocol())
		}
		if strings.Contains(response.Request.URL.String(), ticket) {
			t.Fatal("ticket appeared in URL")
		}
	})

	t.Run("concurrent and repeated ticket connections allow one winner", func(t *testing.T) {
		ticket := issue()
		var wg sync.WaitGroup
		var mu sync.Mutex
		wins := 0
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				connection, _, err := dial(wsURL, ticketProtocolPrefix+ticket, false)
				if err == nil {
					connection.Close()
					mu.Lock()
					wins++
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if wins != 1 {
			t.Fatalf("successful upgrades = %d, want 1", wins)
		}
		if _, response, err := dial(wsURL, ticketProtocolPrefix+ticket, false); err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal("consumed ticket was accepted")
		}
	})

	t.Run("prefixed protocol failures never downgrade to legacy credentials", func(t *testing.T) {
		for _, protocol := range []string{ticketProtocolPrefix + "invalid", ticketProtocolPrefix, ticketProtocolPrefix + issue() + "," + ticketProtocolPrefix + issue()} {
			_, response, err := dial(wsURL, protocol, true)
			if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized || strings.Contains(responseBody(response), "invalid") {
				t.Fatalf("protocol %q did not fail closed", protocol)
			}
		}
	})

	t.Run("legacy succeeds only without a ticket protocol", func(t *testing.T) {
		connection, _, err := dial(wsURL, "", true)
		if err != nil {
			t.Fatalf("legacy dial: %v", err)
		}
		connection.Close()
		_, response, err := dial(wsURL, "", false)
		if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal("stripped protocol without legacy credentials was accepted")
		}
	})

	t.Run("proxy preserves protocol and forbidden workspace burns ticket", func(t *testing.T) {
		target, _ := url.Parse(server.URL)
		proxy := httptest.NewServer(httputil.NewSingleHostReverseProxy(target))
		defer proxy.Close()
		ticket := issue()
		proxyURL := "ws" + strings.TrimPrefix(proxy.URL, "http") + "/sync/ws"
		connection, _, err := dial(proxyURL, ticketProtocolPrefix+ticket, false)
		if err != nil || connection.Subprotocol() != ticketProtocolPrefix+ticket {
			t.Fatalf("proxy protocol preservation: %v", err)
		}
		connection.Close()
		burned := issue()
		_, response, err := websocket.DefaultDialer.Dial(wsURL+"?workspaceId=missing", http.Header{"Sec-WebSocket-Protocol": []string{ticketProtocolPrefix + burned}})
		if err == nil || response == nil || response.StatusCode != http.StatusForbidden || strings.Contains(responseBody(response), burned) {
			t.Fatal("forbidden workspace response leaked or succeeded")
		}
		if _, response, err = dial(wsURL, ticketProtocolPrefix+burned, false); err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal("forbidden workspace did not consume ticket")
		}
		strippingProxy := httputil.NewSingleHostReverseProxy(target)
		originalDirector := strippingProxy.Director
		strippingProxy.Director = func(r *http.Request) {
			originalDirector(r)
			r.Header.Del("Sec-WebSocket-Protocol")
		}
		stripped := httptest.NewServer(strippingProxy)
		defer stripped.Close()
		strippedURL := "ws" + strings.TrimPrefix(stripped.URL, "http") + "/sync/ws"
		if _, response, err := dial(strippedURL, ticketProtocolPrefix+issue(), false); err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal("stripped ticket protocol was accepted without legacy credentials")
		}
	})
}

func responseBody(response *http.Response) string {
	if response == nil || response.Body == nil {
		return ""
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return string(body)
}

func websocketTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Fatal("DATABASE_URL is required for websocket integration tests")
	}
	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("websocket_test_%d", time.Now().UnixNano())
	if _, err := adminPool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = adminPool.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); adminPool.Close() })
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(ctx, pool, filepath.Clean(filepath.Join("..", "..", "migrations"))); err != nil {
		t.Fatal(err)
	}
	return ctx, pool
}

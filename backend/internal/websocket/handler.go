package wsapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
	"github.com/furia/shared-bookmark-sync/backend/internal/httpapi"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
	"github.com/gorilla/websocket"
)

type cursorReader interface {
	CurrentCursor(context.Context, string) (int64, error)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

func RegisterRoutes(mux *http.ServeMux, authService *auth.Service, workspaceService *workspaces.Service, cursors cursorReader, hub *Hub) {
	mux.HandleFunc("GET /sync/ws", func(w http.ResponseWriter, r *http.Request) {
		workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
		if workspaceID == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "workspaceId is required")
			return
		}

		principal, err := authenticateWebsocket(r, authService)
		if err != nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		if _, err := workspaceService.GetAccessibleWorkspace(r.Context(), principal.UserID, workspaceID); err != nil {
			httpapi.WriteError(w, http.StatusForbidden, err.Error())
			return
		}

		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()

		subscription := hub.Subscribe(workspaceID, principal.ClientID)
		defer subscription.Close()

		currentCursor, err := cursors.CurrentCursor(r.Context(), workspaceID)
		if err != nil {
			_ = connection.WriteJSON(map[string]any{"type": "resync_required", "reason": err.Error()})
			return
		}

		if err := connection.WriteJSON(map[string]any{"type": "ack", "workspaceId": workspaceID, "currentCursor": currentCursor}); err != nil {
			return
		}

		readDone := make(chan struct{})
		go drainConnection(connection, readDone)

		for {
			select {
			case <-r.Context().Done():
				return
			case <-readDone:
				return
			case event, ok := <-subscription.Messages:
				if !ok {
					return
				}
				_ = connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := connection.WriteJSON(map[string]any{"type": "event", "event": event}); err != nil {
					return
				}
			}
		}
	})
}

func authenticateWebsocket(r *http.Request, authService *auth.Service) (auth.Principal, error) {
	token := strings.TrimSpace(r.URL.Query().Get("accessToken"))
	if token == "" {
		authorization := strings.TrimSpace(r.Header.Get("Authorization"))
		token = strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
	}

	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if clientID == "" {
		clientID = strings.TrimSpace(r.Header.Get(authService.ClientIDHeader()))
	}

	if token == "" || clientID == "" {
		return auth.Principal{}, errors.New("missing websocket auth")
	}

	return authService.AuthenticateToken(r.Context(), token, clientID)
}

func drainConnection(connection *websocket.Conn, done chan<- struct{}) {
	defer close(done)
	for {
		if _, _, err := connection.ReadMessage(); err != nil {
			return
		}
	}
}

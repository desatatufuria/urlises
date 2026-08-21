package onetimesecrets

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	wsapi "github.com/furia/shared-bookmark-sync/backend/internal/websocket"
)

// hubSecretReadNotifier adapts *wsapi.Hub to this package's unexported
// secretReadNotifier port by calling Hub.PublishToUser under the hood,
// mirroring the adapter wired in cmd/api/main.go (Task 5.1). It lives here,
// not in a non-test file, so onetimesecrets never imports websocket outside
// of this integration-style test proving the wiring works end-to-end.
type hubSecretReadNotifier struct {
	hub *wsapi.Hub
}

func (n hubSecretReadNotifier) NotifySecretRead(ctx context.Context, creatorUserID, secretID string) error {
	return n.hub.PublishToUser(ctx, creatorUserID, map[string]any{
		"type":     "secret_read",
		"secretId": secretID,
		"readAt":   time.Now().UTC().Format(time.RFC3339),
	})
}

// --- Task 4.5/4.6: full create -> reveal -> burn -> notify against a real
// *websocket.Hub, asserting Notifications receives the secret_read frame
// while hub_test.go's existing Messages/byWorkspace coverage is untouched.

func TestBurnNotifiesCreatorOverHubWithoutAffectingWorkspaceMessages(t *testing.T) {
	t.Parallel()

	ctx, pool := openOnetimesecretsTestPool(t, "onetimesecrets_hub_integration_test")
	userID := insertOnetimesecretsTestUser(t, ctx, pool, "creator-hub-integration@example.com")

	hub := wsapi.NewHub()

	// The creator's own open socket — must receive the secret_read frame.
	creatorSubscription := hub.Subscribe("workspace-irrelevant", userID, "client-notify")
	defer creatorSubscription.Close()

	// A completely unrelated user's workspace-scoped subscription. If this
	// receives anything at all — on either Messages or Notifications — the
	// wiring incorrectly broadcast instead of addressing only the creator,
	// or leaked into the workspace-sync path this task must never touch.
	peer := hub.Subscribe("workspace-other", "other-user", "client-peer")
	defer peer.Close()

	notifier := hubSecretReadNotifier{hub: hub}
	mux := secretsHandlerTestMux(userID, pool, notifier)

	created, err := NewService(pool).Create(ctx, userID, CreateSecretInput{Ciphertext: "Y2lwaGVydGV4dA==", IV: "aXZieXRlcw=="})
	if err != nil {
		t.Fatalf("create secret: %v", err)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/secrets/"+created.Token, nil)
	getResp := httptest.NewRecorder()
	mux.ServeHTTP(getResp, getReq)
	if getResp.Code != http.StatusOK {
		t.Fatalf("fetch before burn: status = %d, body=%s", getResp.Code, getResp.Body.String())
	}

	burnReq := httptest.NewRequest(http.MethodPost, "/secrets/"+created.Token+"/burn", nil)
	burnResp := httptest.NewRecorder()
	mux.ServeHTTP(burnResp, burnReq)
	if burnResp.Code != http.StatusOK {
		t.Fatalf("burn: status = %d, body=%s", burnResp.Code, burnResp.Body.String())
	}

	select {
	case frame := <-creatorSubscription.Notifications:
		payload, ok := frame.(map[string]any)
		if !ok {
			t.Fatalf("notification frame has unexpected type %T", frame)
		}
		if payload["type"] != "secret_read" {
			t.Fatalf("frame type = %v, want secret_read", payload["type"])
		}
		if payload["secretId"] != created.ID {
			t.Fatalf("frame secretId = %v, want %q", payload["secretId"], created.ID)
		}
		readAt, ok := payload["readAt"].(string)
		if !ok {
			t.Fatalf("frame readAt has unexpected type %T", payload["readAt"])
		}
		if _, err := time.Parse(time.RFC3339, readAt); err != nil {
			t.Fatalf("frame readAt %q not RFC3339: %v", readAt, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for secret_read notification")
	}

	select {
	case <-peer.Messages:
		t.Fatal("unrelated workspace subscription unexpectedly received a Messages event (Publish/byWorkspace must stay untouched)")
	case <-peer.Notifications:
		t.Fatal("unrelated user unexpectedly received the creator's secret_read notification")
	case <-time.After(200 * time.Millisecond):
	}
}

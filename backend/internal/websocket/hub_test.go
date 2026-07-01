package wsapi

import (
	"context"
	"testing"
	"time"

	syncapi "github.com/furia/shared-bookmark-sync/backend/internal/sync"
)

func TestHubPublishExcludesOrigin(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	origin := hub.Subscribe("workspace-1", "client-a")
	peer := hub.Subscribe("workspace-1", "client-b")
	defer origin.Close()
	defer peer.Close()

	event := syncapi.Envelope{WorkspaceID: "workspace-1", OriginClientID: "client-a", EventID: "evt-1", Cursor: 9}
	if err := hub.Publish(context.Background(), event); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case <-origin.Messages:
		t.Fatal("origin client unexpectedly received its own broadcast")
	case received := <-peer.Messages:
		if received.EventID != event.EventID {
			t.Fatalf("unexpected event id: got %s want %s", received.EventID, event.EventID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for peer broadcast")
	}
}

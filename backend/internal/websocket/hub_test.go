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
	origin := hub.Subscribe("workspace-1", "user-a", "client-a")
	peer := hub.Subscribe("workspace-1", "user-b", "client-b")
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

// --- Task 4.1: byUser index populate/cleanup alongside byWorkspace ---

func TestSubscribePopulatesByUserIndexAlongsideByWorkspace(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	subscription := hub.Subscribe("workspace-1", "user-1", "client-a")
	defer subscription.Close()

	userSubscriptions, ok := hub.byUser["user-1"]
	if !ok {
		t.Fatal(`byUser["user-1"] missing after Subscribe`)
	}
	if _, ok := userSubscriptions[subscription]; !ok {
		t.Fatal("subscription not present in byUser index")
	}

	workspaceSubscriptions, ok := hub.subscriptions["workspace-1"]
	if !ok {
		t.Fatal("workspace index missing after Subscribe")
	}
	if _, ok := workspaceSubscriptions[subscription]; !ok {
		t.Fatal("subscription not present in the existing workspace index")
	}
}

func TestClosingSubscriptionRemovesFromBothIndexes(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	subscription := hub.Subscribe("workspace-1", "user-1", "client-a")
	subscription.Close()

	if subs, ok := hub.byUser["user-1"]; ok {
		if _, present := subs[subscription]; present {
			t.Fatal("subscription still present in byUser index after Close")
		}
		t.Fatal(`byUser["user-1"] bucket not cleaned up after last subscription closed`)
	}

	if subs, ok := hub.subscriptions["workspace-1"]; ok {
		if _, present := subs[subscription]; present {
			t.Fatal("subscription still present in workspace index after Close")
		}
		t.Fatal("workspace bucket not cleaned up after last subscription closed")
	}
}

func TestUserWithTwoWorkspaceSocketsHasTwoByUserEntries(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	subscriptionA := hub.Subscribe("workspace-1", "user-1", "client-a")
	subscriptionB := hub.Subscribe("workspace-2", "user-1", "client-b")
	defer subscriptionA.Close()
	defer subscriptionB.Close()

	userSubscriptions := hub.byUser["user-1"]
	if len(userSubscriptions) != 2 {
		t.Fatalf(`len(byUser["user-1"]) = %d, want 2`, len(userSubscriptions))
	}
	if _, ok := userSubscriptions[subscriptionA]; !ok {
		t.Fatal("subscriptionA missing from byUser index")
	}
	if _, ok := userSubscriptions[subscriptionB]; !ok {
		t.Fatal("subscriptionB missing from byUser index")
	}
}

// --- Task 4.2: PublishToUser delivery semantics ---

func TestPublishToUserDeliversToAllOpenSocketsAcrossWorkspaces(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	subscriptionA := hub.Subscribe("workspace-1", "user-1", "client-a")
	subscriptionB := hub.Subscribe("workspace-2", "user-1", "client-b")
	defer subscriptionA.Close()
	defer subscriptionB.Close()

	message := map[string]any{"type": "secret_read", "secretId": "secret-1"}
	if err := hub.PublishToUser(context.Background(), "user-1", message); err != nil {
		t.Fatalf("publish to user: %v", err)
	}

	for _, subscription := range []*Subscription{subscriptionA, subscriptionB} {
		select {
		case received := <-subscription.Notifications:
			payload, ok := received.(map[string]any)
			if !ok || payload["secretId"] != "secret-1" {
				t.Fatalf("unexpected notification payload: %v", received)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for notification")
		}
	}
}

func TestPublishToUserNoopWhenNoOpenSubscription(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	if err := hub.PublishToUser(context.Background(), "ghost-user", "hello"); err != nil {
		t.Fatalf("publish to offline user: %v", err)
	}
}

func TestPublishToUserDoesNotDeliverToOtherUsersSockets(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	subscriptionA := hub.Subscribe("workspace-1", "user-a", "client-a")
	subscriptionB := hub.Subscribe("workspace-1", "user-b", "client-b")
	defer subscriptionA.Close()
	defer subscriptionB.Close()

	if err := hub.PublishToUser(context.Background(), "user-a", "for-a-only"); err != nil {
		t.Fatalf("publish to user: %v", err)
	}

	select {
	case received := <-subscriptionA.Notifications:
		if received != "for-a-only" {
			t.Fatalf("unexpected payload: %v", received)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for subscriptionA notification")
	}

	select {
	case <-subscriptionB.Notifications:
		t.Fatal("subscriptionB unexpectedly received another user's notification")
	case <-time.After(200 * time.Millisecond):
	}
}

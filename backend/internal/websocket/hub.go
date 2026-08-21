package wsapi

import (
	"context"
	stdsync "sync"

	syncapi "github.com/furia/shared-bookmark-sync/backend/internal/sync"
)

type Hub struct {
	mu            stdsync.RWMutex
	subscriptions map[string]map[*Subscription]struct{}
	// byUser indexes active subscriptions by the subscribing user's
	// identity, independent of WorkspaceID, so a user-addressed
	// notification (e.g. secret_read) can reach every socket that user
	// currently has open, regardless of which workspace(s) it's
	// subscribed to. Additive alongside subscriptions (the existing
	// per-workspace index) — Publish/Messages never read from this map.
	byUser map[string]map[*Subscription]struct{}
}

type Subscription struct {
	WorkspaceID string
	UserID      string
	ClientID    string
	Messages    chan syncapi.Envelope
	// Notifications carries user-addressed, non-workspace-scoped messages
	// delivered via PublishToUser (e.g. secret_read frames). It is a
	// distinct channel from Messages so user notifications never
	// masquerade as syncapi.Envelope-shaped bookmark-sync events.
	Notifications chan any
	hub           *Hub
}

func NewHub() *Hub {
	return &Hub{
		subscriptions: make(map[string]map[*Subscription]struct{}),
		byUser:        make(map[string]map[*Subscription]struct{}),
	}
}

func (h *Hub) Subscribe(workspaceID, userID, clientID string) *Subscription {
	subscription := &Subscription{
		WorkspaceID:   workspaceID,
		UserID:        userID,
		ClientID:      clientID,
		Messages:      make(chan syncapi.Envelope, 16),
		Notifications: make(chan any, 16),
		hub:           h,
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.subscriptions[workspaceID] == nil {
		h.subscriptions[workspaceID] = make(map[*Subscription]struct{})
	}
	h.subscriptions[workspaceID][subscription] = struct{}{}

	if h.byUser[userID] == nil {
		h.byUser[userID] = make(map[*Subscription]struct{})
	}
	h.byUser[userID][subscription] = struct{}{}

	return subscription
}

func (s *Subscription) Close() {
	s.hub.mu.Lock()
	defer s.hub.mu.Unlock()

	workspaceSubscriptions := s.hub.subscriptions[s.WorkspaceID]
	if workspaceSubscriptions == nil {
		return
	}
	if _, ok := workspaceSubscriptions[s]; !ok {
		return
	}

	delete(workspaceSubscriptions, s)
	if len(workspaceSubscriptions) == 0 {
		delete(s.hub.subscriptions, s.WorkspaceID)
	}

	if userSubscriptions := s.hub.byUser[s.UserID]; userSubscriptions != nil {
		delete(userSubscriptions, s)
		if len(userSubscriptions) == 0 {
			delete(s.hub.byUser, s.UserID)
		}
	}

	close(s.Messages)
	close(s.Notifications)
}

func (h *Hub) Publish(_ context.Context, event syncapi.Envelope) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for subscription := range h.subscriptions[event.WorkspaceID] {
		if subscription.ClientID == event.OriginClientID {
			continue
		}

		select {
		case subscription.Messages <- event:
		default:
		}
	}

	return nil
}

// PublishToUser delivers message to every currently-open subscription for
// userID, regardless of which workspace(s) each belongs to. It is
// independent of syncapi.Envelope and never touches the byWorkspace index
// or Messages channel. When userID has no open subscription, this is a
// no-op: no error, no delivery attempt.
func (h *Hub) PublishToUser(_ context.Context, userID string, message any) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for subscription := range h.byUser[userID] {
		select {
		case subscription.Notifications <- message:
		default:
		}
	}

	return nil
}

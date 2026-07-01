package wsapi

import (
	"context"
	stdsync "sync"

	syncapi "github.com/furia/shared-bookmark-sync/backend/internal/sync"
)

type Hub struct {
	mu            stdsync.RWMutex
	subscriptions map[string]map[*Subscription]struct{}
}

type Subscription struct {
	WorkspaceID string
	ClientID    string
	Messages    chan syncapi.Envelope
	hub         *Hub
}

func NewHub() *Hub {
	return &Hub{subscriptions: make(map[string]map[*Subscription]struct{})}
}

func (h *Hub) Subscribe(workspaceID, clientID string) *Subscription {
	subscription := &Subscription{
		WorkspaceID: workspaceID,
		ClientID:    clientID,
		Messages:    make(chan syncapi.Envelope, 16),
		hub:         h,
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.subscriptions[workspaceID] == nil {
		h.subscriptions[workspaceID] = make(map[*Subscription]struct{})
	}
	h.subscriptions[workspaceID][subscription] = struct{}{}

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
	close(s.Messages)
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

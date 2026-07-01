package syncapi

import "testing"

func TestEnsureContiguousAllowsResumeReplay(t *testing.T) {
	t.Parallel()

	events := []Envelope{{Cursor: 121}, {Cursor: 122}, {Cursor: 123}, {Cursor: 124}, {Cursor: 125}}
	if err := ensureContiguous(120, 125, events); err != nil {
		t.Fatalf("expected contiguous replay to pass, got %v", err)
	}
}

func TestEnsureContiguousRejectsReplayGap(t *testing.T) {
	t.Parallel()

	events := []Envelope{{Cursor: 121}, {Cursor: 123}}
	if err := ensureContiguous(120, 123, events); err != ErrResyncRequired {
		t.Fatalf("expected resync_required, got %v", err)
	}
}

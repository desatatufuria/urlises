package syncapi

func ensureContiguous(afterCursor, currentCursor int64, events []Envelope) error {
	if afterCursor >= currentCursor {
		return nil
	}
	if len(events) == 0 {
		return ErrResyncRequired
	}

	expected := afterCursor + 1
	for _, event := range events {
		if event.Cursor != expected {
			return ErrResyncRequired
		}
		expected++
	}

	if expected-1 != currentCursor {
		return ErrResyncRequired
	}

	return nil
}

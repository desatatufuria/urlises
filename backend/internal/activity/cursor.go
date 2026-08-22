package activity

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// cursorSeparator joins the two components of an activity cursor. It is
// safe as a separator: RFC3339Nano never contains "|", and id is a UUID.
const cursorSeparator = "|"

// encodeCursor/decodeCursor round-trip a (createdAt, id) keyset-pagination
// pair through base64.URLEncoding of "<RFC3339Nano createdAt>|<id>". The
// value is opaque to API consumers; it is not meant to be constructed or
// parsed outside this package.
func encodeCursor(createdAt time.Time, id string) string {
	raw := createdAt.Format(time.RFC3339Nano) + cursorSeparator + id
	return base64.URLEncoding.EncodeToString([]byte(raw))
}

// decodeCursor reverses encodeCursor. A malformed cursor (invalid base64,
// missing separator, or an unparsable timestamp) returns a clear error, not
// a panic.
func decodeCursor(cursor string) (createdAt time.Time, id string, err error) {
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("decode activity cursor: invalid encoding: %w", err)
	}

	parts := strings.SplitN(string(raw), cursorSeparator, 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return time.Time{}, "", fmt.Errorf("decode activity cursor: malformed cursor")
	}

	createdAt, err = time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, "", fmt.Errorf("decode activity cursor: invalid timestamp: %w", err)
	}

	return createdAt, parts[1], nil
}

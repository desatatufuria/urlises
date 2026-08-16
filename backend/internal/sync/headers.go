package syncapi

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/furia/shared-bookmark-sync/backend/internal/auth"
)

func MetadataFromRequest(r *http.Request, principal auth.Principal) (Metadata, error) {
	metadata := Metadata{
		EventID:        strings.TrimSpace(r.Header.Get(HeaderEventID)),
		OriginClientID: principal.ClientID,
	}

	if rawCursor := strings.TrimSpace(r.Header.Get(HeaderBaseCursor)); rawCursor != "" {
		parsed, err := strconv.ParseInt(rawCursor, 10, 64)
		if err != nil {
			return Metadata{}, fmt.Errorf("parse %s: %w", HeaderBaseCursor, err)
		}
		metadata.BaseCursor = &parsed
	}

	return metadata, nil
}

func ApplyResponseHeaders(w http.ResponseWriter, event Envelope, duplicate bool) {
	w.Header().Set(HeaderEventID, event.EventID)
	w.Header().Set(HeaderCursor, strconv.FormatInt(event.Cursor, 10))
	w.Header().Set(HeaderDuplicate, strconv.FormatBool(duplicate))
}

func ApplyStoredResponseHeaders(w http.ResponseWriter, headers map[string]string) {
	for key, value := range headers {
		w.Header().Set(key, value)
	}
}

package syncapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Publisher interface {
	Publish(context.Context, Envelope) error
}

type workspaceAccessChecker interface {
	GetAccessibleWorkspace(ctx context.Context, userID, workspaceID string) (workspaces.WorkspaceAccess, error)
}

type PostgresStore struct {
	pool       *pgxpool.Pool
	bookmarks  *bookmarks.Service
	workspaces workspaceAccessChecker
	publisher  Publisher
}

func NewPostgresStore(pool *pgxpool.Pool, bookmarkService *bookmarks.Service, workspaceService workspaceAccessChecker, publisher Publisher) *PostgresStore {
	return &PostgresStore{
		pool:       pool,
		bookmarks:  bookmarkService,
		workspaces: workspaceService,
		publisher:  publisher,
	}
}

func (s *PostgresStore) CreateFolder(ctx context.Context, userID, workspaceID string, input bookmarks.CreateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error) {
	return runMutation(ctx, s, workspaceID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Folder], error) {
		return loadDuplicateMutationByWorkspace[bookmarks.Folder](ctx, tx, workspaceID, eventID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Folder], error) {
		folder, err := s.bookmarks.CreateFolderTx(ctx, tx, userID, workspaceID, input)
		if err != nil {
			return MutationResult[bookmarks.Folder]{}, err
		}

		result, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "folder.created", "folder", folder.ID, folder)
		if err != nil {
			return MutationResult[bookmarks.Folder]{}, err
		}

		return MutationResult[bookmarks.Folder]{Resource: folder, Event: result}, nil
	})
}

func (s *PostgresStore) UpdateFolder(ctx context.Context, userID, folderID string, input bookmarks.UpdateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error) {
	return runMutation(ctx, s, folderID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Folder], error) {
		return loadDuplicateMutationByEntity[bookmarks.Folder](ctx, tx, eventID, "folder", folderID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Folder], error) {
		folder, err := s.bookmarks.UpdateFolderTx(ctx, tx, userID, folderID, input)
		if err != nil {
			return MutationResult[bookmarks.Folder]{}, err
		}

		result, err := s.recordEvent(ctx, tx, userID, folder.WorkspaceID, eventID, metadata.OriginClientID, "folder.updated", "folder", folder.ID, folder)
		if err != nil {
			return MutationResult[bookmarks.Folder]{}, err
		}

		return MutationResult[bookmarks.Folder]{Resource: folder, Event: result}, nil
	})
}

func (s *PostgresStore) DeleteFolder(ctx context.Context, userID, folderID string, metadata Metadata) (DeleteResult, error) {
	return runDeleteMutation(ctx, s, folderID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (DeleteResult, error) {
		return loadDuplicateDeleteByEntity(ctx, tx, eventID, "folder", folderID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (DeleteResult, error) {
		payload, workspaceID, err := s.folderDeletePayload(ctx, tx, folderID)
		if err != nil {
			return DeleteResult{}, err
		}
		if err := s.bookmarks.DeleteFolderTx(ctx, tx, userID, folderID); err != nil {
			return DeleteResult{}, err
		}

		event, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "folder.deleted", "folder", folderID, payload)
		if err != nil {
			return DeleteResult{}, err
		}

		return DeleteResult{Event: event}, nil
	})
}

func (s *PostgresStore) CreateBookmark(ctx context.Context, userID, workspaceID string, input bookmarks.CreateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return runMutation(ctx, s, workspaceID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Bookmark], error) {
		return loadDuplicateMutationByWorkspace[bookmarks.Bookmark](ctx, tx, workspaceID, eventID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Bookmark], error) {
		bookmark, err := s.bookmarks.CreateBookmarkTx(ctx, tx, userID, workspaceID, input)
		if err != nil {
			return MutationResult[bookmarks.Bookmark]{}, err
		}

		result, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "bookmark.created", "bookmark", bookmark.ID, bookmark)
		if err != nil {
			return MutationResult[bookmarks.Bookmark]{}, err
		}

		return MutationResult[bookmarks.Bookmark]{Resource: bookmark, Event: result}, nil
	})
}

func (s *PostgresStore) UpdateBookmark(ctx context.Context, userID, bookmarkID string, input bookmarks.UpdateBookmarkInput, metadata Metadata) (MutationResult[bookmarks.Bookmark], error) {
	return runMutation(ctx, s, bookmarkID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Bookmark], error) {
		return loadDuplicateMutationByEntity[bookmarks.Bookmark](ctx, tx, eventID, "bookmark", bookmarkID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Bookmark], error) {
		bookmark, err := s.bookmarks.UpdateBookmarkTx(ctx, tx, userID, bookmarkID, input)
		if err != nil {
			return MutationResult[bookmarks.Bookmark]{}, err
		}

		result, err := s.recordEvent(ctx, tx, userID, bookmark.WorkspaceID, eventID, metadata.OriginClientID, "bookmark.updated", "bookmark", bookmark.ID, bookmark)
		if err != nil {
			return MutationResult[bookmarks.Bookmark]{}, err
		}

		return MutationResult[bookmarks.Bookmark]{Resource: bookmark, Event: result}, nil
	})
}

func (s *PostgresStore) DeleteBookmark(ctx context.Context, userID, bookmarkID string, metadata Metadata) (DeleteResult, error) {
	return runDeleteMutation(ctx, s, bookmarkID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (DeleteResult, error) {
		return loadDuplicateDeleteByEntity(ctx, tx, eventID, "bookmark", bookmarkID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (DeleteResult, error) {
		payload, workspaceID, err := s.bookmarkDeletePayload(ctx, tx, bookmarkID)
		if err != nil {
			return DeleteResult{}, err
		}
		if err := s.bookmarks.DeleteBookmarkTx(ctx, tx, userID, bookmarkID); err != nil {
			return DeleteResult{}, err
		}

		event, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "bookmark.deleted", "bookmark", bookmarkID, payload)
		if err != nil {
			return DeleteResult{}, err
		}

		return DeleteResult{Event: event}, nil
	})
}

func (s *PostgresStore) ReplayEvents(ctx context.Context, userID, workspaceID string, afterCursor int64) (ReplayResult, error) {
	if _, err := s.workspaces.GetAccessibleWorkspace(ctx, userID, workspaceID); err != nil {
		return ReplayResult{}, err
	}

	currentCursor, err := s.CurrentCursor(ctx, workspaceID)
	if err != nil {
		return ReplayResult{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT cursor, event_id, workspace_id, origin_client_id, event_type, entity_type, entity_id, payload, created_at
		FROM sync_events
		WHERE workspace_id = $1 AND cursor > $2
		ORDER BY cursor ASC
	`, workspaceID, afterCursor)
	if err != nil {
		return ReplayResult{}, fmt.Errorf("query sync events: %w", err)
	}
	defer rows.Close()

	events := make([]Envelope, 0)
	for rows.Next() {
		event, err := scanEnvelope(rows)
		if err != nil {
			return ReplayResult{}, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return ReplayResult{}, fmt.Errorf("iterate sync events: %w", err)
	}

	result := ReplayResult{Events: events, CurrentCursor: currentCursor}
	if err := ensureContiguous(afterCursor, currentCursor, events); err != nil {
		result.ResyncRequired = true
		return result, err
	}

	return result, nil
}

func (s *PostgresStore) CurrentCursor(ctx context.Context, workspaceID string) (int64, error) {
	var cursor int64
	err := s.pool.QueryRow(ctx, `
		SELECT current_cursor
		FROM workspace_cursors
		WHERE workspace_id = $1
	`, workspaceID).Scan(&cursor)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("load workspace cursor: %w", err)
	}

	return cursor, nil
}

func runMutation[T any](ctx context.Context, s *PostgresStore, lockKey string, metadata Metadata, loadDuplicate func(context.Context, pgx.Tx, string) (MutationResult[T], error), apply func(context.Context, pgx.Tx, string) (MutationResult[T], error)) (MutationResult[T], error) {
	eventID, err := ensureEventID(metadata.EventID)
	if err != nil {
		return MutationResult[T]{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MutationResult[T]{}, fmt.Errorf("begin sync mutation tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := lockEventKey(ctx, tx, lockKey, eventID); err != nil {
		return MutationResult[T]{}, err
	}

	if duplicate, err := loadDuplicate(ctx, tx, eventID); err != nil {
		return MutationResult[T]{}, err
	} else if duplicate.Duplicate {
		return duplicate, tx.Commit(ctx)
	}

	result, err := apply(ctx, tx, eventID)
	if err != nil {
		return MutationResult[T]{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return MutationResult[T]{}, fmt.Errorf("commit sync mutation tx: %w", err)
	}

	if s.publisher != nil {
		if err := s.publisher.Publish(ctx, result.Event); err != nil {
			return MutationResult[T]{}, fmt.Errorf("publish sync event: %w", err)
		}
	}

	return result, nil
}

func runDeleteMutation(ctx context.Context, s *PostgresStore, lockKey string, metadata Metadata, loadDuplicate func(context.Context, pgx.Tx, string) (DeleteResult, error), apply func(context.Context, pgx.Tx, string) (DeleteResult, error)) (DeleteResult, error) {
	eventID, err := ensureEventID(metadata.EventID)
	if err != nil {
		return DeleteResult{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeleteResult{}, fmt.Errorf("begin sync mutation tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := lockEventKey(ctx, tx, lockKey, eventID); err != nil {
		return DeleteResult{}, err
	}

	if duplicate, err := loadDuplicate(ctx, tx, eventID); err != nil {
		return DeleteResult{}, err
	} else if duplicate.Duplicate {
		return duplicate, tx.Commit(ctx)
	}

	result, err := apply(ctx, tx, eventID)
	if err != nil {
		return DeleteResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return DeleteResult{}, fmt.Errorf("commit sync mutation tx: %w", err)
	}

	if s.publisher != nil {
		if err := s.publisher.Publish(ctx, result.Event); err != nil {
			return DeleteResult{}, fmt.Errorf("publish sync event: %w", err)
		}
	}

	return result, nil
}

func (s *PostgresStore) recordEvent(ctx context.Context, tx pgx.Tx, userID, workspaceID, eventID, originClientID, eventType, entityType, entityID string, payload any) (Envelope, error) {
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, fmt.Errorf("marshal sync payload: %w", err)
	}

	var envelope Envelope
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		WITH mutation_context AS (
			SELECT w.organization_id AS organization_id, d.id AS device_id
			FROM workspaces w
			LEFT JOIN devices d ON d.user_id = $2 AND d.client_id = $3
			WHERE w.id = $1
		), assigned AS (
			INSERT INTO workspace_cursors (workspace_id, current_cursor, updated_at)
			VALUES ($1, 1, NOW())
			ON CONFLICT (workspace_id) DO UPDATE
			SET current_cursor = workspace_cursors.current_cursor + 1,
			    updated_at = NOW()
			RETURNING current_cursor
		)
		INSERT INTO sync_events (
			event_id, organization_id, workspace_id, user_id, device_id,
			origin_client_id, cursor, event_type, entity_type, entity_id, payload
		)
		SELECT
			$4, mutation_context.organization_id, $1, $2, mutation_context.device_id,
			$3, assigned.current_cursor, $5, $6, $7, $8
		FROM mutation_context, assigned
		RETURNING cursor, event_id, workspace_id, origin_client_id, event_type, entity_type, entity_id, payload, created_at
	`, workspaceID, userID, originClientID, eventID, eventType, entityType, entityID, rawPayload).Scan(
		&envelope.Cursor,
		&envelope.EventID,
		&envelope.WorkspaceID,
		&envelope.OriginClientID,
		&envelope.Kind,
		&envelope.EntityType,
		&envelope.EntityID,
		&envelope.Payload,
		&createdAt,
	)
	if err != nil {
		return Envelope{}, fmt.Errorf("insert sync event: %w", err)
	}

	envelope.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return envelope, nil
}

func (s *PostgresStore) folderDeletePayload(ctx context.Context, tx pgx.Tx, folderID string) (map[string]any, string, error) {
	var workspaceID string
	var parentID *string
	err := tx.QueryRow(ctx, `
		SELECT workspace_id, parent_id
		FROM folders
		WHERE id = $1 AND deleted_at IS NULL
	`, folderID).Scan(&workspaceID, &parentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", bookmarks.ErrNotFound
		}
		return nil, "", fmt.Errorf("load folder delete payload: %w", err)
	}

	return map[string]any{"id": folderID, "workspaceId": workspaceID, "parentId": parentID}, workspaceID, nil
}

func (s *PostgresStore) bookmarkDeletePayload(ctx context.Context, tx pgx.Tx, bookmarkID string) (map[string]any, string, error) {
	var workspaceID, folderID string
	err := tx.QueryRow(ctx, `
		SELECT workspace_id, folder_id
		FROM bookmarks
		WHERE id = $1 AND deleted_at IS NULL
	`, bookmarkID).Scan(&workspaceID, &folderID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", bookmarks.ErrNotFound
		}
		return nil, "", fmt.Errorf("load bookmark delete payload: %w", err)
	}

	return map[string]any{"id": bookmarkID, "workspaceId": workspaceID, "folderId": folderID}, workspaceID, nil
}

func ensureEventID(eventID string) (string, error) {
	if eventID != "" {
		return eventID, nil
	}

	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate event ID: %w", err)
	}

	return hex.EncodeToString(buffer), nil
}

func lockEventKey(ctx context.Context, tx pgx.Tx, lockKey, eventID string) error {
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(lockKey))
	_, _ = hasher.Write([]byte{':'})
	_, _ = hasher.Write([]byte(eventID))
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(hasher.Sum64())); err != nil {
		return fmt.Errorf("lock event key: %w", err)
	}
	return nil
}

type siblingScopeKey struct {
	kind        string
	workspaceID string
	parentID    string
}

type PrepareScopeDriftError struct{}

func (e *PrepareScopeDriftError) Error() string { return "prepare scope drift" }

func IsRetryablePrepareError(err error) bool {
	var drift *PrepareScopeDriftError
	return errors.As(err, &drift)
}

// prepareScopesTx locks every discovered scope before the caller may lock a
// target or sibling row, then refuses the transaction if locked rederivation
// observes different scopes.
func prepareScopesTx(ctx context.Context, tx pgx.Tx, scopes []siblingScopeKey, lockRows func() error, rederive func() ([]siblingScopeKey, error)) error {
	initial := sortedScopeKeys(scopes)
	if err := lockScopesTx(ctx, tx, initial); err != nil {
		return err
	}
	if err := lockRows(); err != nil {
		return err
	}
	current, err := rederive()
	if err != nil {
		return err
	}
	if !equalScopeKeys(initial, sortedScopeKeys(current)) {
		return &PrepareScopeDriftError{}
	}
	return nil
}

func lockScopesTx(ctx context.Context, tx pgx.Tx, scopes []siblingScopeKey) error {
	for _, scope := range sortedScopeKeys(scopes) {
		hash := fnv.New64a()
		_, _ = fmt.Fprintf(hash, "%s:%s:%s", scope.kind, scope.workspaceID, scope.parentID)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(hash.Sum64())); err != nil {
			return fmt.Errorf("lock prepare scope: %w", err)
		}
	}
	return nil
}

func sortedScopeKeys(scopes []siblingScopeKey) []siblingScopeKey {
	keys := append([]siblingScopeKey(nil), scopes...)
	sort.Slice(keys, func(i, j int) bool {
		return keys[i].kind+"\x00"+keys[i].workspaceID+"\x00"+keys[i].parentID < keys[j].kind+"\x00"+keys[j].workspaceID+"\x00"+keys[j].parentID
	})
	result := keys[:0]
	for _, key := range keys {
		if len(result) == 0 || result[len(result)-1] != key {
			result = append(result, key)
		}
	}
	return result
}

func equalScopeKeys(left, right []siblingScopeKey) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func loadDuplicateMutationByWorkspace[T any](ctx context.Context, tx pgx.Tx, workspaceID, eventID string) (MutationResult[T], error) {
	event, ok, err := loadEventByWorkspace(ctx, tx, workspaceID, eventID)
	if err != nil || !ok {
		return MutationResult[T]{}, err
	}

	var resource T
	if len(event.Payload) > 0 {
		if err := json.Unmarshal(event.Payload, &resource); err != nil {
			return MutationResult[T]{}, fmt.Errorf("decode duplicate event payload: %w", err)
		}
	}

	return MutationResult[T]{Resource: resource, Event: event, Duplicate: true}, nil
}

func loadDuplicateMutationByEntity[T any](ctx context.Context, tx pgx.Tx, eventID, entityType, entityID string) (MutationResult[T], error) {
	event, ok, err := loadEventByEntity(ctx, tx, eventID, entityType, entityID)
	if err != nil || !ok {
		return MutationResult[T]{}, err
	}

	var resource T
	if len(event.Payload) > 0 {
		if err := json.Unmarshal(event.Payload, &resource); err != nil {
			return MutationResult[T]{}, fmt.Errorf("decode duplicate event payload: %w", err)
		}
	}

	return MutationResult[T]{Resource: resource, Event: event, Duplicate: true}, nil
}

func loadDuplicateDeleteByEntity(ctx context.Context, tx pgx.Tx, eventID, entityType, entityID string) (DeleteResult, error) {
	event, ok, err := loadEventByEntity(ctx, tx, eventID, entityType, entityID)
	if err != nil || !ok {
		return DeleteResult{}, err
	}

	return DeleteResult{Event: event, Duplicate: true}, nil
}

func loadEventByWorkspace(ctx context.Context, tx pgx.Tx, workspaceID, eventID string) (Envelope, bool, error) {
	row := tx.QueryRow(ctx, `
		SELECT cursor, event_id, workspace_id, origin_client_id, event_type, entity_type, entity_id, payload, created_at
		FROM sync_events
		WHERE workspace_id = $1 AND event_id = $2
	`, workspaceID, eventID)

	event, err := scanEnvelope(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Envelope{}, false, nil
		}
		return Envelope{}, false, err
	}

	return event, true, nil
}

func loadEventByEntity(ctx context.Context, tx pgx.Tx, eventID, entityType, entityID string) (Envelope, bool, error) {
	row := tx.QueryRow(ctx, `
		SELECT cursor, event_id, workspace_id, origin_client_id, event_type, entity_type, entity_id, payload, created_at
		FROM sync_events
		WHERE event_id = $1 AND entity_type = $2 AND entity_id = $3
	`, eventID, entityType, entityID)

	event, err := scanEnvelope(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Envelope{}, false, nil
		}
		return Envelope{}, false, err
	}

	return event, true, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanEnvelope(row scanner) (Envelope, error) {
	var (
		event     Envelope
		createdAt time.Time
	)
	err := row.Scan(
		&event.Cursor,
		&event.EventID,
		&event.WorkspaceID,
		&event.OriginClientID,
		&event.Kind,
		&event.EntityType,
		&event.EntityID,
		&event.Payload,
		&createdAt,
	)
	if err != nil {
		return Envelope{}, err
	}
	event.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return event, nil
}

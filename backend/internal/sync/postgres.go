package syncapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/activity"
	"github.com/furia/shared-bookmark-sync/backend/internal/bookmarks"
	"github.com/furia/shared-bookmark-sync/backend/internal/workspaces"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type workspaceAccessChecker interface {
	GetAccessibleWorkspace(ctx context.Context, userID, workspaceID string) (workspaces.WorkspaceAccess, error)
}

// activityRecorder is the subset of *activity.Service this store depends on,
// mirroring workspaceAccessChecker's narrow-interface pattern above. The
// activity import is type-only (activity.Kind); activity does not import
// sync, so there is no cycle.
type activityRecorder interface {
	Record(ctx context.Context, tx pgx.Tx, orgID, actorUserID string, kind activity.Kind,
		targetType, targetID string, metadata map[string]any) error
}

type PostgresStore struct {
	pool       *pgxpool.Pool
	bookmarks  *bookmarks.Service
	workspaces workspaceAccessChecker
	activity   activityRecorder // NEW — never nil; see design.md Decision 6
	publisher  Publisher
}

func NewPostgresStore(pool *pgxpool.Pool, bookmarkService *bookmarks.Service,
	workspaceService workspaceAccessChecker, activityService activityRecorder,
	publisher Publisher) *PostgresStore {
	return &PostgresStore{
		pool:       pool,
		bookmarks:  bookmarkService,
		workspaces: workspaceService,
		activity:   activityService,
		publisher:  publisher,
	}
}

// activityKindByEventType is the ONLY bridge between sync's wire-protocol
// event_type vocabulary and activity's audit Kind vocabulary. They read alike
// today by convention, not by contract — this table is what makes the
// relationship explicit, reviewable, and fail-closed.
var activityKindByEventType = map[string]activity.Kind{
	"folder.created":   activity.KindFolderCreated,
	"folder.updated":   activity.KindFolderUpdated,
	"folder.deleted":   activity.KindFolderDeleted,
	"bookmark.created": activity.KindBookmarkCreated,
	"bookmark.updated": activity.KindBookmarkUpdated,
	"bookmark.deleted": activity.KindBookmarkDeleted,
}

// folderAuditMetadata projects the audit-relevant fields off a Folder
// (design.md "Recorded metadata" table). It is deliberately a narrow
// projection, never the full resource blob (design.md Decision A).
func folderAuditMetadata(f bookmarks.Folder) map[string]any {
	return map[string]any{"name": f.Name}
}

// bookmarkAuditMetadata projects the audit-relevant fields off a Bookmark
// (design.md "Recorded metadata" table). It is deliberately a narrow
// projection, never the full resource blob (design.md Decision A).
func bookmarkAuditMetadata(b bookmarks.Bookmark) map[string]any {
	return map[string]any{"title": b.Title, "url": b.URL}
}

func (s *PostgresStore) CreateFolder(ctx context.Context, userID, workspaceID string, input bookmarks.CreateFolderInput, metadata Metadata) (MutationResult[bookmarks.Folder], error) {
	return runMutation(ctx, s, workspaceID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Folder], error) {
		return loadDuplicateMutationByWorkspace[bookmarks.Folder](ctx, tx, workspaceID, eventID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (MutationResult[bookmarks.Folder], error) {
		folder, err := s.bookmarks.CreateFolderTx(ctx, tx, userID, workspaceID, input)
		if err != nil {
			return MutationResult[bookmarks.Folder]{}, err
		}

		result, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "folder.created", "folder", folder.ID, folder, folderAuditMetadata(folder))
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

		result, err := s.recordEvent(ctx, tx, userID, folder.WorkspaceID, eventID, metadata.OriginClientID, "folder.updated", "folder", folder.ID, folder, folderAuditMetadata(folder))
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
		payload, audit, workspaceID, err := s.folderDeletePayload(ctx, tx, folderID)
		if err != nil {
			return DeleteResult{}, err
		}
		if err := s.bookmarks.DeleteFolderTx(ctx, tx, userID, folderID); err != nil {
			return DeleteResult{}, err
		}

		event, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "folder.deleted", "folder", folderID, payload, audit)
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

		result, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "bookmark.created", "bookmark", bookmark.ID, bookmark, bookmarkAuditMetadata(bookmark))
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

		result, err := s.recordEvent(ctx, tx, userID, bookmark.WorkspaceID, eventID, metadata.OriginClientID, "bookmark.updated", "bookmark", bookmark.ID, bookmark, bookmarkAuditMetadata(bookmark))
		if err != nil {
			return MutationResult[bookmarks.Bookmark]{}, err
		}

		return MutationResult[bookmarks.Bookmark]{Resource: bookmark, Event: result}, nil
	})
}

func (s *PostgresStore) PrepareFolderPatchTx(ctx context.Context, tx pgx.Tx, userID, folderID string, input bookmarks.UpdateFolderInput) (bookmarks.PreparedFolderPatch, error) {
	return s.bookmarks.PrepareFolderPatchTx(ctx, tx, userID, folderID, input)
}

func (s *PostgresStore) PrepareBookmarkPatchTx(ctx context.Context, tx pgx.Tx, userID, bookmarkID string, input bookmarks.UpdateBookmarkInput) (bookmarks.PreparedBookmarkPatch, error) {
	return s.bookmarks.PrepareBookmarkPatchTx(ctx, tx, userID, bookmarkID, input)
}

// ApplyPreparedFolderPatchTx applies a prepared patch and records its event in
// the caller-owned transaction. Publishing is returned as post-commit data and
// is never invoked here.
func (s *PostgresStore) ApplyPreparedFolderPatchTx(ctx context.Context, tx pgx.Tx, userID string, patch bookmarks.PreparedFolderPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Folder], error) {
	if patch.NoOp {
		return PreparedMutationResult[bookmarks.Folder]{Resource: patch.Final}, nil
	}
	eventID, err := ensureEventID(metadata.EventID)
	if err != nil {
		return PreparedMutationResult[bookmarks.Folder]{}, err
	}
	folder, err := s.bookmarks.ApplyPreparedFolderPatchTx(ctx, tx, patch)
	if err != nil {
		return PreparedMutationResult[bookmarks.Folder]{}, err
	}
	event, err := s.recordEvent(ctx, tx, userID, folder.WorkspaceID, eventID, metadata.OriginClientID, "folder.updated", "folder", folder.ID, folder, folderAuditMetadata(folder))
	if err != nil {
		return PreparedMutationResult[bookmarks.Folder]{}, err
	}
	return PreparedMutationResult[bookmarks.Folder]{Resource: folder, Event: &event, PostCommit: &PostCommit{Publisher: s.publisher, Event: event}}, nil
}

// ApplyPreparedBookmarkPatchTx applies a prepared patch and records its event
// in the caller-owned transaction. Publishing is returned as post-commit data
// and is never invoked here.
func (s *PostgresStore) ApplyPreparedBookmarkPatchTx(ctx context.Context, tx pgx.Tx, userID string, patch bookmarks.PreparedBookmarkPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Bookmark], error) {
	if patch.NoOp {
		return PreparedMutationResult[bookmarks.Bookmark]{Resource: patch.Final}, nil
	}
	eventID, err := ensureEventID(metadata.EventID)
	if err != nil {
		return PreparedMutationResult[bookmarks.Bookmark]{}, err
	}
	bookmark, err := s.bookmarks.ApplyPreparedBookmarkPatchTx(ctx, tx, patch)
	if err != nil {
		return PreparedMutationResult[bookmarks.Bookmark]{}, err
	}
	event, err := s.recordEvent(ctx, tx, userID, bookmark.WorkspaceID, eventID, metadata.OriginClientID, "bookmark.updated", "bookmark", bookmark.ID, bookmark, bookmarkAuditMetadata(bookmark))
	if err != nil {
		return PreparedMutationResult[bookmarks.Bookmark]{}, err
	}
	return PreparedMutationResult[bookmarks.Bookmark]{Resource: bookmark, Event: &event, PostCommit: &PostCommit{Publisher: s.publisher, Event: event}}, nil
}

func (s *PostgresStore) DeleteBookmark(ctx context.Context, userID, bookmarkID string, metadata Metadata) (DeleteResult, error) {
	return runDeleteMutation(ctx, s, bookmarkID+":"+metadata.EventID, metadata, func(ctx context.Context, tx pgx.Tx, eventID string) (DeleteResult, error) {
		return loadDuplicateDeleteByEntity(ctx, tx, eventID, "bookmark", bookmarkID)
	}, func(ctx context.Context, tx pgx.Tx, eventID string) (DeleteResult, error) {
		payload, audit, workspaceID, err := s.bookmarkDeletePayload(ctx, tx, bookmarkID)
		if err != nil {
			return DeleteResult{}, err
		}
		if err := s.bookmarks.DeleteBookmarkTx(ctx, tx, userID, bookmarkID); err != nil {
			return DeleteResult{}, err
		}

		event, err := s.recordEvent(ctx, tx, userID, workspaceID, eventID, metadata.OriginClientID, "bookmark.deleted", "bookmark", bookmarkID, payload, audit)
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

func (s *PostgresStore) recordEvent(ctx context.Context, tx pgx.Tx, userID, workspaceID, eventID, originClientID, eventType, entityType, entityID string, payload any, auditMetadata map[string]any) (Envelope, error) {
	kind, ok := activityKindByEventType[eventType]
	if !ok {
		return Envelope{}, fmt.Errorf("record sync event: unmapped event type %q", eventType)
	}

	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, fmt.Errorf("marshal sync payload: %w", err)
	}

	var envelope Envelope
	var createdAt time.Time
	var organizationID, workspaceName string
	err = tx.QueryRow(ctx, `
		WITH mutation_context AS (
			SELECT w.organization_id AS organization_id, w.name AS workspace_name, d.id AS device_id
			FROM workspaces w
			LEFT JOIN devices d ON d.user_id = $2 AND d.client_id = $3
			WHERE w.id = $1
		), assigned AS (
			INSERT INTO workspace_cursors (workspace_id, current_cursor, updated_at)
			VALUES ($1, 1, NOW())
			ON CONFLICT (workspace_id) DO UPDATE
			SET current_cursor = workspace_cursors.current_cursor + 1, updated_at = NOW()
			RETURNING current_cursor
		), inserted AS (
			INSERT INTO sync_events (
				event_id, organization_id, workspace_id, user_id, device_id,
				origin_client_id, cursor, event_type, entity_type, entity_id, payload
			)
			SELECT $4, mutation_context.organization_id, $1, $2, mutation_context.device_id,
			       $3, assigned.current_cursor, $5, $6, $7, $8
			FROM mutation_context, assigned
			RETURNING cursor, event_id, workspace_id, origin_client_id, event_type,
			          entity_type, entity_id, payload, created_at, organization_id
		)
		SELECT i.cursor, i.event_id, i.workspace_id, i.origin_client_id, i.event_type,
		       i.entity_type, i.entity_id, i.payload, i.created_at,
		       i.organization_id, mutation_context.workspace_name
		FROM inserted i, mutation_context;
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
		&organizationID,
		&workspaceName,
	)
	if err != nil {
		return Envelope{}, fmt.Errorf("insert sync event: %w", err)
	}

	envelope.CreatedAt = createdAt.UTC().Format(time.RFC3339)

	metadata := make(map[string]any, len(auditMetadata)+2)
	for k, v := range auditMetadata {
		metadata[k] = v
	}
	metadata["workspaceId"] = workspaceID
	metadata["workspaceName"] = workspaceName

	if err := s.activity.Record(ctx, tx, organizationID, userID, kind, entityType, entityID, metadata); err != nil {
		return Envelope{}, fmt.Errorf("record activity event: %w", err)
	}

	return envelope, nil
}

// folderDeletePayload runs one SELECT in the caller's transaction immediately
// before the delete, returning both the sync event payload (unchanged keys —
// design.md Decision 4, no extension protocol change) and a separate audit
// projection built from the same row.
func (s *PostgresStore) folderDeletePayload(ctx context.Context, tx pgx.Tx, folderID string) (map[string]any, map[string]any, string, error) {
	var workspaceID string
	var parentID *string
	var name string
	err := tx.QueryRow(ctx, `
		SELECT workspace_id, parent_id, name
		FROM folders
		WHERE id = $1 AND deleted_at IS NULL
	`, folderID).Scan(&workspaceID, &parentID, &name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, "", bookmarks.ErrNotFound
		}
		return nil, nil, "", fmt.Errorf("load folder delete payload: %w", err)
	}

	payload := map[string]any{"id": folderID, "workspaceId": workspaceID, "parentId": parentID}
	audit := map[string]any{"name": name}
	return payload, audit, workspaceID, nil
}

// bookmarkDeletePayload runs one SELECT in the caller's transaction
// immediately before the delete, returning both the sync event payload
// (unchanged keys — design.md Decision 4, no extension protocol change) and a
// separate audit projection built from the same row.
func (s *PostgresStore) bookmarkDeletePayload(ctx context.Context, tx pgx.Tx, bookmarkID string) (map[string]any, map[string]any, string, error) {
	var workspaceID, folderID, title, url string
	err := tx.QueryRow(ctx, `
		SELECT workspace_id, folder_id, title, url
		FROM bookmarks
		WHERE id = $1 AND deleted_at IS NULL
	`, bookmarkID).Scan(&workspaceID, &folderID, &title, &url)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, "", bookmarks.ErrNotFound
		}
		return nil, nil, "", fmt.Errorf("load bookmark delete payload: %w", err)
	}

	payload := map[string]any{"id": bookmarkID, "workspaceId": workspaceID, "folderId": folderID}
	audit := map[string]any{"title": title, "url": url}
	return payload, audit, workspaceID, nil
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

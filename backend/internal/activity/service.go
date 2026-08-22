// Package activity records and lists org-scoped audit/activity events for
// notable mutations (organization, workspace, group changes). Recording is
// atomic with the mutation it describes: Record writes inside the caller's
// existing transaction, immediately before that transaction's own commit —
// never after commit, never through a post-commit/best-effort path. This
// package has zero callers in this work unit; organizations/workspaces/
// groups are wired in later units.
package activity

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/furia/shared-bookmark-sync/backend/internal/access"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Kind identifies the category of an activity event. It is a defined type
// (not a bare string) to give compile-time exhaustiveness pressure at call
// sites, matching access.OrganizationRole's existing type-string pattern in
// this codebase.
type Kind string

const (
	KindOrganizationCreated           Kind = "organization.created"
	KindInvitationCreated             Kind = "invitation.created"
	KindInvitationResent              Kind = "invitation.resent"
	KindInvitationAccepted            Kind = "invitation.accepted"
	KindInvitationCancelled           Kind = "invitation.cancelled"
	KindOrganizationMemberRoleChanged Kind = "organization_member.role_changed"
	KindOrganizationMemberRemoved     Kind = "organization_member.removed"
	KindWorkspaceCreated              Kind = "workspace.created"
	KindWorkspaceDeleted              Kind = "workspace.deleted"
	KindWorkspaceAccessUserGranted    Kind = "workspace_access.user_granted"
	KindWorkspaceAccessUserRevoked    Kind = "workspace_access.user_revoked"
	KindWorkspaceAccessGroupGranted   Kind = "workspace_access.group_granted"
	KindWorkspaceAccessGroupRevoked   Kind = "workspace_access.group_revoked"
	KindGroupCreated                  Kind = "group.created"
	KindGroupRenamed                  Kind = "group.renamed"
	KindGroupDeleted                  Kind = "group.deleted"
	KindGroupMemberAdded              Kind = "group_member.added"
	KindGroupMemberRemoved            Kind = "group_member.removed"
)

// minListLimit and maxListLimit are the clamp bounds ListByOrganization
// applies to its limit parameter. Any limit outside [minListLimit,
// maxListLimit] — including <= 0 — is clamped into range, never treated as
// "unbounded". The 50-row *default* applied when an HTTP caller omits the
// query param entirely is the Phase 2 handler's responsibility, not this
// method's.
const (
	minListLimit = 1
	maxListLimit = 100
)

// Service wraps the connection pool used to record and list activity
// events. It mirrors secrethide.Service's/organizations.Service's shape.
type Service struct {
	pool *pgxpool.Pool
}

// NewService constructs a Service backed by pool.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// Record writes one activity_events row inside the caller's existing
// transaction, immediately before tx.Commit(). orgID is always a concrete
// organization ID — there is no nullable/org-less variant in v1: every
// legitimate caller (organizations, workspaces, groups) always has a real
// organization ID in scope at the call site.
func (s *Service) Record(
	ctx context.Context,
	tx pgx.Tx,
	orgID string,
	actorUserID string,
	kind Kind,
	targetType string,
	targetID string,
	metadata map[string]any,
) error {
	if metadata == nil {
		metadata = map[string]any{}
	}

	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("marshal activity metadata: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO activity_events (organization_id, actor_user_id, kind, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, orgID, actorUserID, string(kind), targetType, targetID, metadataJSON); err != nil {
		return fmt.Errorf("record activity event: %w", err)
	}

	return nil
}

// Event is one activity_events row, shaped for the (Phase 2) HTTP response:
// actor identity fields are nullable since actor_user_id is ON DELETE SET
// NULL (a former member's events survive their own removal).
type Event struct {
	ID             string         `json:"id"`
	OrganizationID string         `json:"organizationId"`
	ActorUserID    *string        `json:"actorUserId,omitempty"`
	ActorEmail     *string        `json:"actorEmail,omitempty"`
	ActorName      *string        `json:"actorName,omitempty"`
	Kind           Kind           `json:"kind"`
	TargetType     string         `json:"targetType"`
	TargetID       string         `json:"targetId"`
	Metadata       map[string]any `json:"metadata"`
	CreatedAt      string         `json:"createdAt"`
}

// ListByOrganization enforces access.RequireOrganizationAdmin, then returns
// up to limit events newest-first (created_at DESC, id DESC). cursor is the
// opaque token from a prior page's nextCursor, or "" for the first page.
// nextCursor is "" when no further page exists. limit is clamped to
// [minListLimit, maxListLimit]; a non-positive limit falls back to
// defaultListLimit.
func (s *Service) ListByOrganization(
	ctx context.Context,
	requesterUserID string,
	organizationID string,
	cursor string,
	limit int,
) (events []Event, nextCursor string, err error) {
	if err := access.RequireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return nil, "", err
	}

	limit = clampListLimit(limit)

	var (
		cursorCreatedAt time.Time
		cursorID        string
		hasCursor       bool
	)
	if cursor != "" {
		cursorCreatedAt, cursorID, err = decodeCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("decode activity cursor: %w", err)
		}
		hasCursor = true
	}

	query := `
		SELECT e.id, e.organization_id, e.actor_user_id, u.email, u.name, e.kind, e.target_type, e.target_id, e.metadata, e.created_at
		FROM activity_events e
		LEFT JOIN users u ON u.id = e.actor_user_id
		WHERE e.organization_id = $1
	`
	args := []any{organizationID}
	if hasCursor {
		query += ` AND (e.created_at, e.id) < ($2, $3)`
		args = append(args, cursorCreatedAt, cursorID)
	}
	query += fmt.Sprintf(" ORDER BY e.created_at DESC, e.id DESC LIMIT $%d", len(args)+1)
	args = append(args, limit+1)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("query activity events: %w", err)
	}
	defer rows.Close()

	fetched := make([]Event, 0, limit+1)
	var (
		createdAtValues []time.Time
		idValues        []string
	)
	for rows.Next() {
		var (
			event        Event
			metadataJSON []byte
			createdAt    time.Time
		)
		if err := rows.Scan(
			&event.ID,
			&event.OrganizationID,
			&event.ActorUserID,
			&event.ActorEmail,
			&event.ActorName,
			&event.Kind,
			&event.TargetType,
			&event.TargetID,
			&metadataJSON,
			&createdAt,
		); err != nil {
			return nil, "", fmt.Errorf("scan activity event: %w", err)
		}

		metadata := map[string]any{}
		if len(metadataJSON) > 0 {
			if err := json.Unmarshal(metadataJSON, &metadata); err != nil {
				return nil, "", fmt.Errorf("unmarshal activity metadata: %w", err)
			}
		}
		event.Metadata = metadata
		event.CreatedAt = createdAt.Format(time.RFC3339Nano)

		fetched = append(fetched, event)
		createdAtValues = append(createdAtValues, createdAt)
		idValues = append(idValues, event.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("iterate activity events: %w", err)
	}

	if len(fetched) > limit {
		fetched = fetched[:limit]
		nextCursor = encodeCursor(createdAtValues[limit-1], idValues[limit-1])
	}

	return fetched, nextCursor, nil
}

func clampListLimit(limit int) int {
	if limit < minListLimit {
		return minListLimit
	}
	if limit > maxListLimit {
		return maxListLimit
	}
	return limit
}

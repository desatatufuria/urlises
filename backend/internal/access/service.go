package access

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrForbidden = errors.New("forbidden")

type OrganizationRole string

const (
	OrganizationRoleOwner  OrganizationRole = "owner"
	OrganizationRoleAdmin  OrganizationRole = "admin"
	OrganizationRoleMember OrganizationRole = "member"
)

type WorkspaceRole string

const (
	WorkspaceRoleAdmin  WorkspaceRole = "admin"
	WorkspaceRoleEditor WorkspaceRole = "editor"
	WorkspaceRoleViewer WorkspaceRole = "viewer"
)

type Service struct {
	pool *pgxpool.Pool
}

type WorkspaceAccessQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

type OrganizationAccessQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type EffectiveWorkspaceAccess struct {
	WorkspaceID      string        `json:"workspaceId"`
	WorkspaceName    string        `json:"workspaceName"`
	WorkspaceType    string        `json:"workspaceType"`
	OrganizationID   string        `json:"organizationId"`
	OrganizationName string        `json:"organizationName"`
	Role             WorkspaceRole `json:"role"`
	Sources          []string      `json:"sources"`
}

type workspaceMetadata struct {
	WorkspaceID      string
	WorkspaceName    string
	WorkspaceType    string
	OrganizationID   string
	OrganizationName string
}

type workspaceGrant struct {
	Role   WorkspaceRole
	Source string
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) IsOrganizationAdmin(ctx context.Context, userID, organizationID string) (bool, error) {
	return IsOrganizationAdmin(ctx, s.pool, userID, organizationID)
}

// IsOrganizationAdmin is choke point 12: the JOIN's AND o.deleted_at IS NULL
// closes activity.ListByOrganization and all 8 workspaces org-admin gates
// that call through this function against a soft-deleted organization.
func IsOrganizationAdmin(ctx context.Context, querier OrganizationAccessQuerier, userID, organizationID string) (bool, error) {
	var role string
	err := querier.QueryRow(ctx, `
		SELECT om.role
		FROM organization_members om
		JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
		WHERE om.organization_id = $1 AND om.user_id = $2
	`, organizationID, userID).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("query organization membership: %w", err)
	}

	return isOrganizationAdmin(OrganizationRole(role)), nil
}

func (s *Service) RequireOrganizationAdmin(ctx context.Context, userID, organizationID string) error {
	return RequireOrganizationAdmin(ctx, s.pool, userID, organizationID)
}

func RequireOrganizationAdmin(ctx context.Context, querier OrganizationAccessQuerier, userID, organizationID string) error {
	allowed, err := IsOrganizationAdmin(ctx, querier, userID, organizationID)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}

	return nil
}

func (s *Service) GetEffectiveWorkspaceAccess(ctx context.Context, userID, workspaceID string) (EffectiveWorkspaceAccess, error) {
	return GetEffectiveWorkspaceAccess(ctx, s.pool, userID, workspaceID)
}

func GetEffectiveWorkspaceAccess(ctx context.Context, querier WorkspaceAccessQuerier, userID, workspaceID string) (EffectiveWorkspaceAccess, error) {
	metadata, err := loadWorkspaceMetadata(ctx, querier, workspaceID)
	if err != nil {
		return EffectiveWorkspaceAccess{}, err
	}

	grants, err := loadWorkspaceGrants(ctx, querier, userID, workspaceID)
	if err != nil {
		return EffectiveWorkspaceAccess{}, err
	}

	return resolveEffectiveWorkspaceAccess(metadata, grants)
}

func (s *Service) RequireWorkspaceWriteAccess(ctx context.Context, userID, workspaceID string) (EffectiveWorkspaceAccess, error) {
	return RequireWorkspaceWriteAccess(ctx, s.pool, userID, workspaceID)
}

func RequireWorkspaceWriteAccess(ctx context.Context, querier WorkspaceAccessQuerier, userID, workspaceID string) (EffectiveWorkspaceAccess, error) {
	access, err := GetEffectiveWorkspaceAccess(ctx, querier, userID, workspaceID)
	if err != nil {
		return EffectiveWorkspaceAccess{}, err
	}
	if !canWriteWorkspace(access.Role) {
		return EffectiveWorkspaceAccess{}, ErrForbidden
	}

	return access, nil
}

// loadWorkspaceMetadata is choke point 13: the HIGHEST-LEVERAGE choke point
// in the whole inventory. AND w.deleted_at IS NULL AND o.deleted_at IS NULL
// closes GetEffectiveWorkspaceAccess (and therefore
// RequireWorkspaceWriteAccess, GetAccessibleWorkspace, GetTree, bookmark
// mutations, sync ListChanges/ReplayEvents, and websocket connect) against a
// soft-deleted workspace or a workspace inside a soft-deleted organization.
func loadWorkspaceMetadata(ctx context.Context, querier WorkspaceAccessQuerier, workspaceID string) (workspaceMetadata, error) {
	var metadata workspaceMetadata
	err := querier.QueryRow(ctx, `
		SELECT w.id, w.name, w.type, o.id, o.name
		FROM workspaces w
		JOIN organizations o ON o.id = w.organization_id
		WHERE w.id = $1 AND w.deleted_at IS NULL AND o.deleted_at IS NULL
	`, workspaceID).Scan(
		&metadata.WorkspaceID,
		&metadata.WorkspaceName,
		&metadata.WorkspaceType,
		&metadata.OrganizationID,
		&metadata.OrganizationName,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return workspaceMetadata{}, ErrForbidden
		}
		return workspaceMetadata{}, fmt.Errorf("query workspace metadata: %w", err)
	}

	return metadata, nil
}

func loadWorkspaceGrants(ctx context.Context, querier WorkspaceAccessQuerier, userID, workspaceID string) ([]workspaceGrant, error) {
	rows, err := querier.Query(ctx, `
		SELECT role, source
		FROM (
			SELECT wua.role AS role, 'direct' AS source
			FROM workspace_user_access wua
			WHERE wua.user_id = $1 AND wua.workspace_id = $2

			UNION ALL

			SELECT wga.role AS role, 'group:' || wga.group_id::text AS source
			FROM workspace_group_access wga
			JOIN group_members gm ON gm.group_id = wga.group_id
			WHERE gm.user_id = $1 AND wga.workspace_id = $2
		) grants
	`, userID, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("query workspace grants: %w", err)
	}
	defer rows.Close()

	grants := make([]workspaceGrant, 0)
	for rows.Next() {
		var grant workspaceGrant
		if err := rows.Scan(&grant.Role, &grant.Source); err != nil {
			return nil, fmt.Errorf("scan workspace grant: %w", err)
		}
		grants = append(grants, grant)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace grants: %w", err)
	}

	return grants, nil
}

func resolveEffectiveWorkspaceAccess(metadata workspaceMetadata, grants []workspaceGrant) (EffectiveWorkspaceAccess, error) {
	bestRole, err := highestWorkspaceRole(grants)
	if err != nil {
		return EffectiveWorkspaceAccess{}, err
	}

	return EffectiveWorkspaceAccess{
		WorkspaceID:      metadata.WorkspaceID,
		WorkspaceName:    metadata.WorkspaceName,
		WorkspaceType:    metadata.WorkspaceType,
		OrganizationID:   metadata.OrganizationID,
		OrganizationName: metadata.OrganizationName,
		Role:             bestRole,
		Sources:          mergeSources(grants),
	}, nil
}

func highestWorkspaceRole(grants []workspaceGrant) (WorkspaceRole, error) {
	bestRank := 0
	var bestRole WorkspaceRole

	for _, grant := range grants {
		rank, ok := workspaceRoleRank(grant.Role)
		if !ok {
			return "", fmt.Errorf("unsupported workspace role %q", grant.Role)
		}
		if rank > bestRank {
			bestRank = rank
			bestRole = grant.Role
		}
	}

	if bestRank == 0 {
		return "", ErrForbidden
	}

	return bestRole, nil
}

func mergeSources(grants []workspaceGrant) []string {
	if len(grants) == 0 {
		return nil
	}

	seen := make(map[string]struct{}, len(grants))
	groupSources := make([]string, 0, len(grants))
	hasDirect := false

	for _, grant := range grants {
		if _, exists := seen[grant.Source]; exists {
			continue
		}
		seen[grant.Source] = struct{}{}

		if grant.Source == "direct" {
			hasDirect = true
			continue
		}

		groupSources = append(groupSources, grant.Source)
	}

	sort.Strings(groupSources)
	sources := make([]string, 0, len(groupSources)+1)
	if hasDirect {
		sources = append(sources, "direct")
	}
	sources = append(sources, groupSources...)

	return sources
}

func isOrganizationAdmin(role OrganizationRole) bool {
	switch role {
	case OrganizationRoleOwner, OrganizationRoleAdmin:
		return true
	default:
		return false
	}
}

func canWriteWorkspace(role WorkspaceRole) bool {
	switch role {
	case WorkspaceRoleAdmin, WorkspaceRoleEditor:
		return true
	default:
		return false
	}
}

func workspaceRoleRank(role WorkspaceRole) (int, bool) {
	switch role {
	case WorkspaceRoleAdmin:
		return 3, true
	case WorkspaceRoleEditor:
		return 2, true
	case WorkspaceRoleViewer:
		return 1, true
	default:
		return 0, false
	}
}

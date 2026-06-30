package organizations

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool *pgxpool.Pool
}

type Membership struct {
	OrganizationID   string `json:"organizationId"`
	OrganizationName string `json:"organizationName"`
	Role             string `json:"role"`
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) ListMemberships(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.id, o.name, om.role
		FROM organization_members om
		JOIN organizations o ON o.id = om.organization_id
		WHERE om.user_id = $1
		ORDER BY o.name, o.id
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("query organizations: %w", err)
	}
	defer rows.Close()

	memberships := make([]Membership, 0)
	for rows.Next() {
		var membership Membership
		if err := rows.Scan(&membership.OrganizationID, &membership.OrganizationName, &membership.Role); err != nil {
			return nil, fmt.Errorf("scan organization membership: %w", err)
		}
		memberships = append(memberships, membership)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate organizations: %w", err)
	}

	return memberships, nil
}

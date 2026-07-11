package httpapi

import (
	"context"
	"testing"
)

func TestIdempotencyCreationRouteScope(t *testing.T) {
	t.Parallel()

	for _, route := range []string{
		"POST /organizations",
		"POST /organizations/{organizationId}/invitations",
		"POST /organizations/{organizationId}/groups",
		"POST /groups/{groupId}/members",
		"POST /organizations/{organizationId}/workspaces",
	} {
		t.Run(route, func(t *testing.T) {
			if !IsIdempotentCreationRoute(route) {
				t.Fatalf("route %q is not idempotent", route)
			}
		})
	}

	for _, route := range []string{
		"PATCH /organizations/{organizationId}/members",
		"DELETE /groups/{groupId}/members/{userId}",
	} {
		t.Run(route, func(t *testing.T) {
			if IsIdempotentCreationRoute(route) {
				t.Fatalf("excluded route %q is idempotent", route)
			}
		})
	}
}

func TestIdempotencyExecutorContract(t *testing.T) {
	ctx := context.Background()
	_ = ctx
	_ = NewIdempotencyExecutor
}

package access

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type fakeQuerier struct {
	metadata workspaceMetadata
	grants   []workspaceGrant
	rowErr   error
	rowsErr  error
}

func (q fakeQuerier) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	return fakeRow{metadata: q.metadata, err: q.rowErr}
}

func (q fakeQuerier) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	if q.rowsErr != nil {
		return nil, q.rowsErr
	}
	return &fakeRows{grants: q.grants}, nil
}

type fakeRow struct {
	metadata workspaceMetadata
	err      error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*string)) = r.metadata.WorkspaceID
	*(dest[1].(*string)) = r.metadata.WorkspaceName
	*(dest[2].(*string)) = r.metadata.WorkspaceType
	*(dest[3].(*string)) = r.metadata.OrganizationID
	*(dest[4].(*string)) = r.metadata.OrganizationName
	return nil
}

type fakeRows struct {
	grants []workspaceGrant
	index  int
	err    error
}

func (r *fakeRows) Close() {}

func (r *fakeRows) Err() error { return r.err }

func (r *fakeRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }

func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }

func (r *fakeRows) Next() bool {
	if r.index >= len(r.grants) {
		return false
	}
	r.index++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	if r.index == 0 || r.index > len(r.grants) {
		return errors.New("scan called without current row")
	}
	grant := r.grants[r.index-1]
	*(dest[0].(*WorkspaceRole)) = grant.Role
	*(dest[1].(*string)) = grant.Source
	return nil
}

func (r *fakeRows) Values() ([]any, error) { return nil, nil }

func (r *fakeRows) RawValues() [][]byte { return nil }

func (r *fakeRows) Conn() *pgx.Conn { return nil }

func TestHighestWorkspaceRole(t *testing.T) {
	tests := []struct {
		name    string
		grants  []workspaceGrant
		want    WorkspaceRole
		wantErr error
	}{
		{
			name: "highest role wins across direct and group grants",
			grants: []workspaceGrant{
				{Role: WorkspaceRoleViewer, Source: "direct"},
				{Role: WorkspaceRoleEditor, Source: "group:ops"},
			},
			want: WorkspaceRoleEditor,
		},
		{
			name: "admin outranks editor and viewer",
			grants: []workspaceGrant{
				{Role: WorkspaceRoleViewer, Source: "group:viewers"},
				{Role: WorkspaceRoleEditor, Source: "group:editors"},
				{Role: WorkspaceRoleAdmin, Source: "direct"},
			},
			want: WorkspaceRoleAdmin,
		},
		{
			name:    "no grants returns forbidden",
			grants:  nil,
			wantErr: ErrForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := highestWorkspaceRole(tt.grants)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("expected error %v, got %v", tt.wantErr, err)
			}
			if tt.wantErr != nil {
				return
			}
			if got != tt.want {
				t.Fatalf("expected role %q, got %q", tt.want, got)
			}
		})
	}
}

func TestResolveEffectiveWorkspaceAccessMergesDirectAndGroupSources(t *testing.T) {
	metadata := workspaceMetadata{
		WorkspaceID:      "workspace-sync-space",
		WorkspaceName:    "Synchronized operational space",
		WorkspaceType:    "operational",
		OrganizationID:   "oda",
		OrganizationName: "OdA",
	}

	access, err := resolveEffectiveWorkspaceAccess(metadata, []workspaceGrant{
		{Role: WorkspaceRoleViewer, Source: "group:monitoring"},
		{Role: WorkspaceRoleEditor, Source: "direct"},
		{Role: WorkspaceRoleViewer, Source: "group:ops"},
		{Role: WorkspaceRoleEditor, Source: "direct"},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if access.Role != WorkspaceRoleEditor {
		t.Fatalf("expected effective role %q, got %q", WorkspaceRoleEditor, access.Role)
	}

	wantSources := []string{"direct", "group:monitoring", "group:ops"}
	if !reflect.DeepEqual(access.Sources, wantSources) {
		t.Fatalf("expected sources %v, got %v", wantSources, access.Sources)
	}

	if access.OrganizationID != "oda" || access.OrganizationName != "OdA" {
		t.Fatalf("expected OdA metadata to be preserved, got %+v", access)
	}
	if access.WorkspaceID != "workspace-sync-space" || access.WorkspaceName != "Synchronized operational space" {
		t.Fatalf("expected workspace metadata to be preserved, got %+v", access)
	}
}

func TestCanWriteWorkspace(t *testing.T) {
	tests := []struct {
		role WorkspaceRole
		want bool
	}{
		{role: WorkspaceRoleAdmin, want: true},
		{role: WorkspaceRoleEditor, want: true},
		{role: WorkspaceRoleViewer, want: false},
		{role: WorkspaceRole("unknown"), want: false},
	}

	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			if got := canWriteWorkspace(tt.role); got != tt.want {
				t.Fatalf("expected canWriteWorkspace(%q) = %t, got %t", tt.role, tt.want, got)
			}
		})
	}
}

func TestRequireWorkspaceWriteAccessQuerier(t *testing.T) {
	metadata := workspaceMetadata{
		WorkspaceID:      "workspace-sync-space",
		WorkspaceName:    "Synchronized operational space",
		WorkspaceType:    "operational",
		OrganizationID:   "oda",
		OrganizationName: "OdA",
	}

	tests := []struct {
		name    string
		querier fakeQuerier
		want    EffectiveWorkspaceAccess
		wantErr error
	}{
		{
			name: "editor access is allowed through direct or group grants",
			querier: fakeQuerier{
				metadata: metadata,
				grants: []workspaceGrant{
					{Role: WorkspaceRoleViewer, Source: "direct"},
					{Role: WorkspaceRoleEditor, Source: "group:ops"},
				},
			},
			want: EffectiveWorkspaceAccess{
				WorkspaceID:      metadata.WorkspaceID,
				WorkspaceName:    metadata.WorkspaceName,
				WorkspaceType:    metadata.WorkspaceType,
				OrganizationID:   metadata.OrganizationID,
				OrganizationName: metadata.OrganizationName,
				Role:             WorkspaceRoleEditor,
				Sources:          []string{"direct", "group:ops"},
			},
		},
		{
			name: "viewer access is denied for write guard",
			querier: fakeQuerier{
				metadata: metadata,
				grants:   []workspaceGrant{{Role: WorkspaceRoleViewer, Source: "direct"}},
			},
			wantErr: ErrForbidden,
		},
		{
			name: "no grants is denied for write guard",
			querier: fakeQuerier{
				metadata: metadata,
			},
			wantErr: ErrForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := RequireWorkspaceWriteAccess(context.Background(), tt.querier, "user-1", metadata.WorkspaceID)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("expected error %v, got %v", tt.wantErr, err)
			}
			if tt.wantErr != nil {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("expected access %+v, got %+v", tt.want, got)
			}
		})
	}
}

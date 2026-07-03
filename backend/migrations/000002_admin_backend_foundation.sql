ALTER TABLE organization_members
    DROP CONSTRAINT IF EXISTS organization_members_role_check;

UPDATE organization_members
SET role = CASE role
    WHEN 'admin' THEN 'admin'
    WHEN 'editor' THEN 'member'
    WHEN 'viewer' THEN 'member'
    ELSE role
END;

ALTER TABLE organization_members
    ADD CONSTRAINT organization_members_role_check
    CHECK (role IN ('owner', 'admin', 'member'));

CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')) DEFAULT 'pending',
    invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitations_organization_id ON invitations (organization_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations (status);

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_groups_organization_id ON groups (organization_id);

CREATE TABLE IF NOT EXISTS group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members (user_id);

CREATE TABLE IF NOT EXISTS workspace_user_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_user_access_user_id ON workspace_user_access (user_id);

CREATE TABLE IF NOT EXISTS workspace_group_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_group_access_group_id ON workspace_group_access (group_id);

INSERT INTO workspace_user_access (workspace_id, user_id, role, created_at)
SELECT workspace_id, user_id, role, created_at
FROM workspace_members
ON CONFLICT (workspace_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    created_at = EXCLUDED.created_at;

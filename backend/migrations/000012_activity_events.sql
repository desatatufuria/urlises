CREATE TABLE IF NOT EXISTS activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_org_created_id
    ON activity_events (organization_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor_user_id
    ON activity_events (actor_user_id);

-- Rollback: DROP TABLE activity_events; additive only, no existing data touched.

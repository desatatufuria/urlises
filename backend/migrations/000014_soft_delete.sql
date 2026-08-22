ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Trash-side partial indexes only. They contain solely soft-deleted rows, so they are
-- near-empty in steady state and are never touched by writes to live rows. They serve
-- BOTH the hourly purge scan (deleted_at < NOW() - interval) and the two Trash list
-- queries (deleted_at IS NOT NULL).
-- Deliberately NO index on the "not deleted" hot path: those reads are always
-- WHERE id = $1 AND deleted_at IS NULL, or a PK/FK join, so the predicate filters a row
-- the existing index has already located -- same reasoning as 000013's disabled_at.
CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at
    ON organizations (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_deleted_at
    ON workspaces (deleted_at) WHERE deleted_at IS NOT NULL;

-- deleted_by_user_id is ON DELETE SET NULL, matching activity_events.actor_user_id:
-- a deleter's own account removal must not block or cascade the trashed row.
-- NOTE: these deleted_at columns are the ORG/WORKSPACE RECOVERY WINDOW mechanism.
-- They are NOT the folders/bookmarks sync tombstone from 000001, which shares only
-- the column name (cursor protocol, no restore, no purge).
-- Rollback: see design.md "Migration / Rollout" -- decide the fate of pending rows
--   BEFORE reverting code, or every trashed entity resurrects as live.
--   ALTER TABLE organizations DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by_user_id;
--   ALTER TABLE workspaces    DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by_user_id;

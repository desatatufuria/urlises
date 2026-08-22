ALTER TABLE users
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- Nullable with no default: every existing row is active with no backfill.
-- No index: disabled_at is only ever read as an extra predicate alongside a
-- unique/PK lookup (users.email, users.id), so it filters an already-located
-- single row.
-- Rollback: ALTER TABLE users DROP COLUMN IF EXISTS disabled_at;
--   revert the login()/AuthenticateToken gates FIRST (restores access),
--   drop the column in a follow-up.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ui_theme TEXT NOT NULL DEFAULT 'slate';

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_ui_theme_valid,
    ADD CONSTRAINT users_ui_theme_valid CHECK (ui_theme IN ('slate', 'indigo', 'teal'));

-- Rollback prerequisite: no other column depends on ui_theme; dropping the
-- constraint and column is safe at any time.

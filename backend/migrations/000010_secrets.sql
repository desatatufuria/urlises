CREATE TABLE IF NOT EXISTS secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    ciphertext BYTEA NOT NULL,
    iv BYTEA NOT NULL,
    wrapped_content_key BYTEA,
    passphrase_salt BYTEA,
    kdf_iterations INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending', 'read')) DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_secrets_user_id ON secrets (user_id);
CREATE INDEX IF NOT EXISTS idx_secrets_status_expires_at ON secrets (status, expires_at);

-- Rollback: DROP TABLE secrets; additive only, no existing data touched.

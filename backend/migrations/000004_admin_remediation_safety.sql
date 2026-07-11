-- 000003 may already be recorded in shared environments. Reconcile legacy
-- pending rows before relying on its partial unique invitation index.
UPDATE invitations
SET status = 'expired',
    updated_at = NOW()
WHERE status = 'pending'
  AND expires_at IS NOT NULL
  AND expires_at <= NOW();

WITH ranked_pending_invitations AS (
    SELECT id,
        ROW_NUMBER() OVER (
            PARTITION BY organization_id, lower(email)
            ORDER BY created_at DESC, id DESC
        ) AS row_number
    FROM invitations
    WHERE status = 'pending'
      AND (expires_at IS NULL OR expires_at > NOW())
)
UPDATE invitations
SET status = 'cancelled',
    updated_at = NOW()
FROM ranked_pending_invitations ranked
WHERE invitations.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending_email_per_organization
    ON invitations (organization_id, lower(email))
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    response_status INTEGER,
    safe_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (principal_id, method, route, key)
);

ALTER TABLE idempotency_records
    ADD CONSTRAINT idempotency_records_key_not_blank CHECK (length(btrim(key)) > 0 AND length(key) <= 255),
    ADD CONSTRAINT idempotency_records_terminal_response CHECK (
        (status = 'completed' AND response_status = 201 AND safe_response IS NOT NULL AND completed_at IS NOT NULL)
        OR
        (status <> 'completed' AND response_status IS NULL AND safe_response IS NULL AND completed_at IS NULL)
    );

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
    ON idempotency_records (expires_at);

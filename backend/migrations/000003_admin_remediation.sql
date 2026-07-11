-- Prevent semantic duplicates when a client retries a creation after an
-- ambiguous transport outcome. API idempotency keys are retained client-side;
-- these constraints are the database backstop.
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

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_unique_name_type_per_organization
    ON workspaces (organization_id, name, type);

ALTER TABLE secrets
    ADD COLUMN IF NOT EXISTS sent_to_email TEXT;

-- Rollback: ALTER TABLE secrets DROP COLUMN IF EXISTS sent_to_email;
-- Rollback prerequisite: no other column depends on sent_to_email; dropping
-- it is safe at any time (it only ever mirrors the most recent send-email
-- recipient and is never read back into any decryption path).

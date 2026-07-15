-- General receipt fields are nullable so existing 201 creation receipts remain valid.
ALTER TABLE idempotency_records
    ADD COLUMN IF NOT EXISTS response_headers JSONB,
    ADD COLUMN IF NOT EXISTS ack_cursor BIGINT;

ALTER TABLE idempotency_records
    DROP CONSTRAINT IF EXISTS idempotency_records_terminal_response,
    ADD CONSTRAINT idempotency_records_terminal_response CHECK (
        (status = 'completed' AND response_status IN (200, 201) AND safe_response IS NOT NULL AND completed_at IS NOT NULL)
        OR
        (status <> 'completed' AND response_status IS NULL AND safe_response IS NULL AND response_headers IS NULL AND ack_cursor IS NULL AND completed_at IS NULL)
    );

-- Rollback prerequisite: remove or allow expiry of all completed 200 receipts
-- before restoring the previous 201-only terminal-response constraint.

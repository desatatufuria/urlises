CREATE TABLE ws_tickets (
    ticket_hash BYTEA PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 seconds'),
    consumed_at TIMESTAMPTZ,
    CONSTRAINT ws_tickets_expiry CHECK (expires_at = created_at + INTERVAL '30 seconds')
);
CREATE INDEX ws_tickets_active_idx ON ws_tickets (expires_at) WHERE consumed_at IS NULL;

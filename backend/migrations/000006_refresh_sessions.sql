CREATE TABLE refresh_families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    rotation_count INTEGER NOT NULL DEFAULT 0,
    revoked_at TIMESTAMPTZ,
    reuse_detected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES refresh_families(id) ON DELETE CASCADE,
    secret_hash BYTEA NOT NULL UNIQUE,
    retired_at TIMESTAMPTZ,
    retry_attempt_id TEXT,
    retry_until TIMESTAMPTZ,
    rotated_to_id UUID REFERENCES refresh_tokens(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX refresh_families_user_id_idx ON refresh_families(user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens(family_id);

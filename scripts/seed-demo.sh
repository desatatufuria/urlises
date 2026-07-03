#!/usr/bin/env bash
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-shared-bookmark-sync-postgres}"
DB_NAME="${DB_NAME:-shared_bookmark_sync}"
DB_USER="${DB_USER:-postgres}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SCRIPT="${SCRIPT_DIR}/remote-bookmarks.mjs"

USER_ID="${USER_ID:-}"
BACKEND_URL="${BACKEND_URL:-http://localhost:8081}"
SEED_EMAIL="${SEED_EMAIL:-admin@example.com}"
SEED_PASSWORD="${SEED_PASSWORD:-secret123}"
SEED_NAME="${SEED_NAME:-Admin}"
SESSION_FILE="${SESSION_FILE:-/tmp/shared-bookmark-sync-seed-session.json}"

if [[ -z "$USER_ID" ]]; then
  if node "$REMOTE_SCRIPT" register \
    --backend-url "$BACKEND_URL" \
    --email "$SEED_EMAIL" \
    --password "$SEED_PASSWORD" \
    --name "$SEED_NAME" \
    --client-id test-client-1 \
    --session-file "$SESSION_FILE" >/dev/null 2>&1; then
    :
  else
    node "$REMOTE_SCRIPT" login \
      --backend-url "$BACKEND_URL" \
      --email "$SEED_EMAIL" \
      --password "$SEED_PASSWORD" \
      --client-id test-client-1 \
      --session-file "$SESSION_FILE" >/dev/null
  fi

  USER_ID="$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(data.session.user.id);" "$SESSION_FILE")"
fi

docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" <<SQL
insert into organizations (id, name, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'Acme', now(), now())
on conflict do nothing;

insert into workspaces (id, organization_id, name, type, created_at, updated_at)
values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'OdA', 'team', now(), now())
on conflict do nothing;

insert into organization_members (id, organization_id, user_id, role, created_at)
values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '$USER_ID', 'admin', now())
on conflict do nothing;

insert into workspace_members (id, workspace_id, user_id, role, created_at)
values
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', '$USER_ID', 'admin', now())
on conflict do nothing;

insert into folders (id, workspace_id, parent_id, name, position, created_at, updated_at)
values
  ('796ccd23-5990-4d7d-a09e-57ec9902b4b3', '22222222-2222-2222-2222-222222222222', null, 'sacyr', 0, now(), now()),
  ('7914448d-9b1b-43da-aa56-e62427f72a06', '22222222-2222-2222-2222-222222222222', null, 'BANCAMARCH', 1, now(), now())
on conflict do nothing;

insert into bookmarks (id, workspace_id, folder_id, title, url, position, created_at, updated_at)
values
  ('f804aac2-bf7f-4917-a6f4-804242ed236f', '22222222-2222-2222-2222-222222222222', '796ccd23-5990-4d7d-a09e-57ec9902b4b3', 'google', 'https://www.google.com/', 0, now(), now()),
  ('a9a12cf5-3e23-4248-ab1a-037ed82592cb', '22222222-2222-2222-2222-222222222222', '796ccd23-5990-4d7d-a09e-57ec9902b4b3', 'Remote Google 2', 'https://www.google.com', 1, now(), now()),
  ('8c323498-7cd1-415a-8705-3d401d2cf1b9', '22222222-2222-2222-2222-222222222222', '796ccd23-5990-4d7d-a09e-57ec9902b4b3', 'Google Remote', 'https://www.google.com', 2, now(), now())
on conflict do nothing;

insert into devices (id, user_id, name, client_id, created_at, last_seen_at)
values
  ('55555555-5555-5555-5555-555555555555', '$USER_ID', 'Primary Browser', 'test-client-1', now(), now()),
  ('66666666-6666-6666-6666-666666666666', '$USER_ID', 'Remote Test Client', 'remote-test-client', now(), now())
on conflict do nothing;

insert into workspace_cursors (workspace_id, current_cursor, updated_at)
values
  ('22222222-2222-2222-2222-222222222222', 0, now())
on conflict (workspace_id) do nothing;
SQL

echo "Seed demo completed for user $USER_ID"

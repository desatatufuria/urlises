#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/activate-local-invitation.sh <email>

Development-only helper for accepting the newest pending local invitation for an
email address. It registers a local test account when needed, otherwise logs in.

Environment:
  BACKEND_URL    Backend URL (default: http://localhost:8081)

The script prompts for the password and never stores or prints it.
EOF
}

emit_auth_payload() {
  local endpoint="$1"
  local email="$2"
  local password="$3"
  local device_name="$4"

  case "$endpoint" in
    register)
      INVITATION_PASSWORD="$password" jq -n \
        --arg email "$email" \
        --arg deviceName "$device_name" \
        '{email: $email, name: "Local invitation test user", password: env.INVITATION_PASSWORD, deviceName: $deviceName}'
      ;;
    login)
      INVITATION_PASSWORD="$password" jq -n \
        --arg email "$email" \
        --arg deviceName "$device_name" \
        '{email: $email, password: env.INVITATION_PASSWORD, deviceName: $deviceName}'
      ;;
    *)
      printf 'Unsupported authentication endpoint.\n' >&2
      return 2
      ;;
  esac
}

check_payload_shapes() {
  local temp_dir register_payload login_payload

  if ! command -v jq >/dev/null 2>&1; then
    printf 'Required command is unavailable: jq\n' >&2
    return 1
  fi

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/shared-bookmark-sync-payloads.XXXXXX")"
  register_payload="${temp_dir}/register.json"
  login_payload="${temp_dir}/login.json"

  if ! emit_auth_payload register 'shape-check@example.invalid' 'shape-check-password' 'shape-check-client' >"$register_payload" \
    || ! emit_auth_payload login 'shape-check@example.invalid' 'shape-check-password' 'shape-check-client' >"$login_payload" \
    || ! jq -e 'has("name") and (.name | type == "string")' "$register_payload" >/dev/null \
    || ! jq -e 'has("name") | not' "$login_payload" >/dev/null; then
    rm -rf -- "$temp_dir"
    return 1
  fi

  rm -rf -- "$temp_dir"
  printf 'Payload shape checks passed: registration includes name; login excludes name.\n'
}

format_acceptance_response() {
  local payload="$1"

  jq -e '
    if ((.organizationId? | type) == "string" and (.organizationId | length > 0)
      and (.organizationName? | type) == "string" and (.organizationName | length > 0)
      and (.role? | type) == "string" and (.role | length > 0))
    then {organizationId, organizationName, role}
    else error("acceptance response is missing required fields")
    end
  ' <<<"$payload" 2>/dev/null
}

check_acceptance_response() {
  local fixture
  fixture='{"organizationId":"11111111-1111-1111-1111-111111111111","organizationName":"Acme","role":"member"}'

  format_acceptance_response "$fixture" >/dev/null
  printf 'Acceptance response fixture check passed: organizationId, organizationName, and role are required.\n'
}

# Runtime execution begins.
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--check-payload-shapes" ]]; then
  check_payload_shapes
  exit $?
fi

if [[ "${1:-}" == "--check-acceptance-response" ]]; then
  check_acceptance_response
  exit $?
fi

if [[ "$#" -ne 1 ]]; then
  usage >&2
  exit 2
fi

for command in curl jq docker; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$command" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
BACKEND_URL="${BACKEND_URL:-http://localhost:8081}"
DB_NAME="${DB_NAME:-shared_bookmark_sync}"
DB_USER="${DB_USER:-postgres}"
EMAIL="$1"
PASSWORD=""
ACCESS_TOKEN=""
INVITATION_TOKEN=""
CLIENT_ID="local-invitation-$(date +%s)-$$-${RANDOM}${RANDOM}"
AUTH_RESPONSE=""
ACCEPT_RESPONSE=""
AUTH_STATUS=""
ACCEPT_STATUS=""
accept_body=""
ACCEPTED_INVITATION=""

cleanup() {
  unset -v PASSWORD ACCESS_TOKEN INVITATION_TOKEN AUTH_RESPONSE ACCEPT_RESPONSE AUTH_STATUS ACCEPT_STATUS accept_body ACCEPTED_INVITATION
}

trap cleanup EXIT
trap 'exit 130' INT TERM

shopt -s extglob
EMAIL="${EMAIL##+([[:space:]])}"
EMAIL="${EMAIL%%+([[:space:]])}"
EMAIL="${EMAIL,,}"

if [[ -z "$EMAIL" || "$EMAIL" != *@* ]]; then
  printf 'Provide a valid email address.\n' >&2
  exit 2
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  printf 'Project Compose file was not found.\n' >&2
  exit 1
fi

if ! docker compose -f "$COMPOSE_FILE" version >/dev/null 2>&1; then
  printf 'Docker Compose is unavailable. Start Docker and retry.\n' >&2
  exit 1
fi

if ! curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
  "${BACKEND_URL}/healthz" >/dev/null; then
  printf 'Backend is unreachable at %s. Start the local Compose stack and retry.\n' "$BACKEND_URL" >&2
  exit 1
fi

account_exists() {
  local result

  result="$(printf '%s\n' \
    "SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = :'email');" \
    | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -X -q -t -A -v ON_ERROR_STOP=1 -v email="$EMAIL" -U "$DB_USER" -d "$DB_NAME" 2>/dev/null)" || return 2

  case "$result" in
    t) return 0 ;;
    f) return 1 ;;
    *) return 2 ;;
  esac
}

auth_status_description() {
  if [[ -z "$AUTH_STATUS" ]]; then
    printf 'backend request failed before an HTTP response'
  else
    printf 'HTTP %s' "$AUTH_STATUS"
  fi
}

verify_accepted_invitation() {
  local record

  record="$(printf '%s\n' \
    "SELECT json_build_object('email', email, 'role', role, 'status', status, 'accepted_at', accepted_at) FROM invitations WHERE lower(email) = :'email' AND status = 'accepted' AND accepted_at IS NOT NULL ORDER BY accepted_at DESC LIMIT 1;" \
    | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -X -q -t -A -v ON_ERROR_STOP=1 -v email="$EMAIL" -U "$DB_USER" -d "$DB_NAME" 2>/dev/null)" || return 2

  [[ -n "$record" ]] || return 1
  jq -e '
    if ((.email? | type) == "string" and (.email | length > 0)
      and (.role? | type) == "string" and (.role | length > 0)
      and .status == "accepted" and .accepted_at != null)
    then {email, role, status, accepted_at}
    else error("accepted invitation verification is incomplete")
    end
  ' <<<"$record" 2>/dev/null
}

ACCOUNT_CHECK_RESULT=0
account_exists || ACCOUNT_CHECK_RESULT=$?
case "$ACCOUNT_CHECK_RESULT" in
  0) printf 'Existing local account found for %s; login will be attempted.\n' "$EMAIL" ;;
  1) printf 'No local account found for %s; registration will be attempted.\n' "$EMAIL" ;;
  *)
    printf 'Could not query the local account state. Check PostgreSQL and retry.\n' >&2
    exit 1
    ;;
esac

printf 'Password for %s: ' "$EMAIL" >&2
IFS= read -r -s PASSWORD
printf '\n' >&2

if [[ -z "$PASSWORD" ]]; then
  printf 'A password is required.\n' >&2
  exit 2
fi

request_session() {
  local endpoint="$1"
  local response_body

  AUTH_RESPONSE="$(emit_auth_payload "$endpoint" "$EMAIL" "$PASSWORD" "$CLIENT_ID" | curl --silent --show-error --connect-timeout 3 --max-time 15 \
    --data-binary @- \
    --write-out $'\n%{http_code}' \
    --header 'Content-Type: application/json' \
    --header "X-Client-Id: $CLIENT_ID" \
    "${BACKEND_URL}/auth/${endpoint}")" || return 1

  AUTH_STATUS="${AUTH_RESPONSE##*$'\n'}"
  response_body="${AUTH_RESPONSE%$'\n'*}"
  [[ "$AUTH_STATUS" =~ ^2[0-9][0-9]$ ]] || return 1
  ACCESS_TOKEN="$(jq -er '.accessToken' <<<"$response_body")" || return 1
  AUTH_RESPONSE=""
}

if [[ "$ACCOUNT_CHECK_RESULT" == "0" ]]; then
  if ! request_session login; then
    printf 'Existing account password was rejected (%s).\n' "$(auth_status_description)" >&2
    exit 1
  fi
elif ! request_session register; then
  REGISTRATION_STATUS="$AUTH_STATUS"
  ACCOUNT_CHECK_RESULT=0
  account_exists || ACCOUNT_CHECK_RESULT=$?

  case "$ACCOUNT_CHECK_RESULT" in
    0)
      printf 'Registration did not complete; an account now exists. Attempting login.\n' >&2
      if ! request_session login; then
        printf 'Existing account password was rejected (%s).\n' "$(auth_status_description)" >&2
        exit 1
      fi
      ;;
    1)
      if [[ -z "$REGISTRATION_STATUS" ]]; then
        printf 'Registration request failed before an HTTP response. Check the backend and retry.\n' >&2
      else
        printf 'Registration was rejected by the backend (HTTP %s).\n' "$REGISTRATION_STATUS" >&2
      fi
      exit 1
      ;;
    *)
      printf 'Registration did not complete and the local account state could not be queried.\n' >&2
      exit 1
      ;;
  esac
fi

INVITATION_TOKEN="$(printf '%s\n' \
  "SELECT token FROM invitations WHERE lower(email) = :'email' AND status = 'pending' ORDER BY created_at DESC LIMIT 1;" \
  | docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -X -q -t -A -v ON_ERROR_STOP=1 -v email="$EMAIL" -U "$DB_USER" -d "$DB_NAME")" || {
  printf 'Could not query the local PostgreSQL invitation data.\n' >&2
  exit 1
}

if [[ -z "$INVITATION_TOKEN" ]]; then
  printf 'No pending local invitation was found for %s.\n' "$EMAIL" >&2
  exit 1
fi

ACCEPT_RESPONSE="$(printf '%s\n' \
  'request = "POST"' \
  "url = \"${BACKEND_URL}/invitations/${INVITATION_TOKEN}/accept\"" \
  "header = \"Authorization: Bearer ${ACCESS_TOKEN}\"" \
  "header = \"X-Client-Id: ${CLIENT_ID}\"" \
  | curl --silent --show-error --connect-timeout 3 --max-time 15 \
    --config - \
    --write-out $'\n%{http_code}')" || {
  printf 'Invitation acceptance request failed. Check the local backend and retry.\n' >&2
  exit 1
}

ACCEPT_STATUS="${ACCEPT_RESPONSE##*$'\n'}"
accept_body="${ACCEPT_RESPONSE%$'\n'*}"

if [[ ! "$ACCEPT_STATUS" =~ ^2[0-9][0-9]$ ]]; then
  printf 'Invitation acceptance was rejected by the local backend.\n' >&2
  exit 1
fi

if ! format_acceptance_response "$accept_body"; then
  printf 'Invitation acceptance response was incomplete. Do not retry blindly; verify the local database state first.\n' >&2
  exit 1
fi

if ! ACCEPTED_INVITATION="$(verify_accepted_invitation)"; then
  printf 'HTTP acceptance succeeded, but database verification failed; acceptance may already be committed. Do not retry blindly.\n' >&2
  exit 1
fi

printf 'Accepted invitation verification:\n%s\n' "$ACCEPTED_INVITATION"

cat <<'EOF'

Next browser checks:
1. Sign in as a non-admin and confirm an admin route shows the authorization failure state.
2. Add the user to a flat group, reload group details, and confirm the member remains listed.
3. Add direct and group grants for one workspace, then confirm Access shows both sources and the highest effective role.
EOF

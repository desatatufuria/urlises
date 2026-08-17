#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SESSION_FILE="/tmp/shared-bookmark-sync-poc-session.env"
COMPOSE=(docker compose --project-directory "${REPO_ROOT}" -f "${REPO_ROOT}/docker-compose.yml")

for tool in docker curl jq go; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    printf 'Required tool not found: %s\n' "${tool}" >&2
    exit 1
  fi
done

show_logs() {
  "${COMPOSE[@]}" logs --tail=100 postgres backend admin-web mailpit >&2 || true
}

fail() {
  printf 'POC test failed: %s\n' "$1" >&2
  show_logs
  exit 1
}

on_error() {
  local status=$?
  printf 'POC test failed unexpectedly (exit %d).\n' "${status}" >&2
  show_logs
  exit "${status}"
}
trap on_error ERR

wait_for_http() {
  local label=$1
  local internal_url=$2
  local host_url=$3
  local output_variable=$4
  local attempt

  for attempt in {1..60}; do
    if curl --fail --silent --show-error --max-time 2 "${internal_url}" >/dev/null 2>&1; then
      printf -v "${output_variable}" '%s' "${internal_url}"
      return
    fi
    if curl --fail --silent --show-error --max-time 2 "${host_url}" >/dev/null 2>&1; then
      printf -v "${output_variable}" '%s' "${host_url}"
      return
    fi
    sleep 2
  done

  fail "${label} did not become ready"
}

smtp_ready() {
  local address=$1
  local banner
  banner="$(curl --silent --max-time 2 "telnet://${address}" 2>/dev/null || true)"
  [[ "${banner}" == 220* ]]
}

wait_for_smtp() {
  local attempt

  for attempt in {1..60}; do
    if smtp_ready shared-bookmark-sync-mailpit:1025; then
      SMTP_ADDR=shared-bookmark-sync-mailpit:1025
      return
    fi
    if smtp_ready 127.0.0.1:11025; then
      SMTP_ADDR=127.0.0.1:11025
      return
    fi
    sleep 2
  done

  fail "Mailpit SMTP did not become ready"
}

new_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    tr '[:upper:]' '[:lower:]' </proc/sys/kernel/random/uuid
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return
  fi
  fail "cannot generate a UUID: /proc UUID and uuidgen are unavailable"
}

post_json() {
  local url=$1
  local payload=$2
  shift 2
  curl --silent --show-error --write-out $'\n%{http_code}' \
    --request POST \
    --header 'Content-Type: application/json' \
    "$@" \
    --data "${payload}" \
    "${url}"
}

printf 'Ensuring shared Docker network exists...\n'
if ! docker network inspect dtf-netwok >/dev/null 2>&1; then
  if ! docker network create dtf-netwok >/dev/null; then
    printf 'POC test failed: cannot create required Docker network dtf-netwok. Check Docker access.\n' >&2
    exit 1
  fi
fi

printf 'Starting POC services...\n'
"${COMPOSE[@]}" up -d --build postgres backend admin-web mailpit

wait_for_http \
  "backend" \
  "http://shared-bookmark-sync-backend:8080/readyz" \
  "http://127.0.0.1:8081/readyz" \
  BACKEND_READY_URL
API_BASE_URL="${BACKEND_READY_URL%/readyz}"

ADMIN_WEB_BINDING="$("${COMPOSE[@]}" port admin-web 80)" || fail "cannot resolve the admin web host port"
ADMIN_WEB_PORT="${ADMIN_WEB_BINDING##*:}"
if [[ ! "${ADMIN_WEB_PORT}" =~ ^[0-9]+$ ]]; then
  fail "admin web host port is invalid: ${ADMIN_WEB_BINDING}"
fi
ADMIN_WEB_URL="http://127.0.0.1:${ADMIN_WEB_PORT}"

wait_for_http \
  "admin web" \
  "http://shared-bookmark-sync-admin-web/" \
  "${ADMIN_WEB_URL}/" \
  ADMIN_WEB_READY_URL

wait_for_http \
  "admin web API proxy" \
  "http://shared-bookmark-sync-admin-web/api/readyz" \
  "${ADMIN_WEB_URL}/api/readyz" \
  ADMIN_WEB_API_READY_URL

wait_for_smtp

USER_UUID="$(new_uuid)"
CLIENT_ID="$(new_uuid)"
IDEMPOTENCY_KEY="$(new_uuid)"
EMAIL="poc+${USER_UUID}@local.test"
PASSWORD="Poc!${USER_UUID}aA9"
ORGANIZATION_NAME="POC Organization"

REGISTER_PAYLOAD="$(jq -cn \
  --arg email "${EMAIL}" \
  --arg name "POC User" \
  --arg password "${PASSWORD}" \
  --arg deviceName "POC Test Harness" \
  '{email: $email, name: $name, password: $password, deviceName: $deviceName}')"
REGISTER_RAW="$(post_json \
  "${API_BASE_URL}/auth/register" \
  "${REGISTER_PAYLOAD}" \
  --header "X-Client-Id: ${CLIENT_ID}")"
REGISTER_STATUS="${REGISTER_RAW##*$'\n'}"
REGISTER_BODY="${REGISTER_RAW%$'\n'*}"
if [[ "${REGISTER_STATUS}" != "201" ]]; then
  printf 'Registration response (%s): %s\n' "${REGISTER_STATUS}" "${REGISTER_BODY}" >&2
  fail "user registration failed"
fi
ACCESS_TOKEN="$(jq -er '.accessToken | select(type == "string" and length > 0)' <<<"${REGISTER_BODY}")" || fail "registration response has no accessToken"
USER_ID="$(jq -er '.user.id | select(type == "string" and length > 0)' <<<"${REGISTER_BODY}")" || fail "registration response has no user ID"

ORGANIZATION_PAYLOAD="$(jq -cn --arg name "${ORGANIZATION_NAME}" '{name: $name}')"
ORGANIZATION_RAW="$(post_json \
  "${API_BASE_URL}/organizations" \
  "${ORGANIZATION_PAYLOAD}" \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  --header "X-Client-Id: ${CLIENT_ID}" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}")"
ORGANIZATION_STATUS="${ORGANIZATION_RAW##*$'\n'}"
ORGANIZATION_BODY="${ORGANIZATION_RAW%$'\n'*}"
if [[ "${ORGANIZATION_STATUS}" != "201" ]]; then
  printf 'Organization response (%s): %s\n' "${ORGANIZATION_STATUS}" "${ORGANIZATION_BODY}" >&2
  fail "organization creation failed"
fi
ORGANIZATION_ID="$(jq -er '.organizationId | select(type == "string" and length > 0)' <<<"${ORGANIZATION_BODY}")" || fail "organization response has no organization ID"
RESPONSE_ORGANIZATION_NAME="$(jq -er '.organizationName | select(type == "string" and length > 0)' <<<"${ORGANIZATION_BODY}")" || fail "organization response has no organization name"
if [[ "${RESPONSE_ORGANIZATION_NAME}" != "${ORGANIZATION_NAME}" ]]; then
  fail "organization response has an unexpected name"
fi

(
  cd "${REPO_ROOT}/backend"
  MAILPIT_SMOKE_TEST=1 MAILPIT_SMOKE_ADDR="${SMTP_ADDR}" go test ./internal/mailer -run TestMailpitSmoke
)

umask 077
{
  printf 'API_BASE_URL=%q\n' "${API_BASE_URL}"
  printf 'ADMIN_WEB_URL=%q\n' "${ADMIN_WEB_URL}"
  printf 'MAILPIT_UI_URL=%q\n' "http://127.0.0.1:${MAILPIT_UI_HOST_PORT:-18025}"
  printf 'SMTP_ADDR=%q\n' "${SMTP_ADDR}"
  printf 'EMAIL=%q\n' "${EMAIL}"
  printf 'PASSWORD=%q\n' "${PASSWORD}"
  printf 'CLIENT_ID=%q\n' "${CLIENT_ID}"
  printf 'ACCESS_TOKEN=%q\n' "${ACCESS_TOKEN}"
  printf 'USER_ID=%q\n' "${USER_ID}"
  printf 'ORGANIZATION_ID=%q\n' "${ORGANIZATION_ID}"
  printf 'ORGANIZATION_NAME=%q\n' "${ORGANIZATION_NAME}"
} >"${SESSION_FILE}"
chmod 600 "${SESSION_FILE}"

trap - ERR
printf '\nPOC test ready\n'
printf 'Admin UI:       %s\n' "${ADMIN_WEB_URL}"
printf 'Mailpit UI:     http://127.0.0.1:%s\n' "${MAILPIT_UI_HOST_PORT:-18025}"
printf 'Email:          %s\n' "${EMAIL}"
printf 'Password:       %s\n' "${PASSWORD}"
printf 'Organization:   %s (%s)\n' "${ORGANIZATION_NAME}" "${ORGANIZATION_ID}"
printf 'Session file:   %s\n' "${SESSION_FILE}"
printf 'Note: invitation email is not wired in this POC.\n'

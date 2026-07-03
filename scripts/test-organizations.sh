#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

TEST_DB_HOST="${TEST_DB_HOST:-telemetry.host}"
TEST_DB_PORT="${TEST_DB_PORT:-5433}"

export ORGANIZATIONS_TEST_DATABASE_URL="${ORGANIZATIONS_TEST_DATABASE_URL:-postgres://postgres:postgres@${TEST_DB_HOST}:${TEST_DB_PORT}/shared_bookmark_sync?sslmode=disable}"

cd "${REPO_ROOT}/backend"
go test ./internal/organizations -run 'TestAcceptInvitation(ActivatesMembershipAndRejectsReuse|RejectsExpiredInvite)$' -count=1 -v

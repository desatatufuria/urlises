#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_url="${ADMIN_TEST_DATABASE_URL:-}"
if [[ -z "$database_url" ]]; then
  printf '%s\n' 'ADMIN_TEST_DATABASE_URL is required; database-backed admin contracts were not executed.' >&2
  exit 3
fi

export ADMIN_TEST_DATABASE_URL="$database_url"
export ORGANIZATIONS_TEST_DATABASE_URL="$database_url"
export GROUPS_TEST_DATABASE_URL="$database_url"
export WORKSPACES_TEST_DATABASE_URL="$database_url"
export HTTPAPI_TEST_DATABASE_URL="$database_url"
export DATABASE_URL="$database_url"

cd "$root/backend"
if ! output="$(go test -json -count=1 -v ./internal/organizations ./internal/groups ./internal/workspaces ./internal/httpapi 2>&1)"; then
  printf '%s\n' 'database-backed admin contracts failed; test output withheld to protect credentials.' >&2
  exit 1
fi

if grep -Eq '"Action":"skip"|--- SKIP:|\[no tests to run\]' <<<"$output"; then
  printf '%s\n' 'database-backed admin contracts skipped; refusing success.' >&2
  exit 1
fi

require_marker() {
  local package="$1"
  local test_name="$2"
  local run_marker="\"Action\":\"run\".*\"Package\":\"$package\".*\"Test\":\"$test_name\""
  local pass_marker="\"Action\":\"pass\".*\"Package\":\"$package\".*\"Test\":\"$test_name\""
  if ! grep -Eq "$run_marker" <<<"$output" || ! grep -Eq "$pass_marker" <<<"$output"; then
    printf 'missing named database contract marker for %s/%s; refusing success.\n' "$package" "$test_name" >&2
    exit 1
  fi
  printf 'CONTRACT_MARKER package=%s test=%s run=PASS return=PASS\n' "$package" "$test_name"
}

require_marker 'github.com/furia/shared-bookmark-sync/backend/internal/organizations' 'TestMigrationFrom000002ReconcilesLegacyPendingInvitations'
require_marker 'github.com/furia/shared-bookmark-sync/backend/internal/groups' 'TestAddMemberRejectsUserOutsideOrganization'
require_marker 'github.com/furia/shared-bookmark-sync/backend/internal/workspaces' 'TestCreateWorkspaceGrantsOnlyCreatorAdmin'
require_marker 'github.com/furia/shared-bookmark-sync/backend/internal/httpapi' 'TestIdempotencyExecutorPostgresContracts'

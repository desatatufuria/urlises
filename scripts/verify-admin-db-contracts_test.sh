#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/verify-admin-db-contracts.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/go" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${FAKE_GO_CWD_FILE:-}" ]]; then
  printf '%s' "$PWD" >"$FAKE_GO_CWD_FILE"
fi
printf '%s\n' "${FAKE_GO_OUTPUT:-PASS}"
exit "${FAKE_GO_EXIT:-0}"
EOF
chmod +x "$tmp/bin/go"

run_case() {
  set +e
  case_output="$(cd "$tmp" && PATH="$tmp/bin:$PATH" ADMIN_TEST_DATABASE_URL="${ADMIN_TEST_DATABASE_URL:-postgres://safe}" "$script" 2>&1)"
  case_status=$?
  set -e
}

expect_failure() {
  local name="$1"
  run_case
  if [[ $case_status -eq 0 ]]; then
    printf 'expected failure: %s\n%s\n' "$name" "$case_output" >&2
    return 1
  fi
}

set +e
missing_output="$(env -u ADMIN_TEST_DATABASE_URL -u DATABASE_URL "$script" 2>&1)"
missing_status=$?
set -e
[[ $missing_status -eq 3 ]] && [[ "$missing_output" != *'postgres://'* ]]

FAKE_GO_EXIT=1 FAKE_GO_OUTPUT='dial tcp 127.0.0.1:1: connect: refused' expect_failure 'unreachable go command'
FAKE_GO_EXIT=0 FAKE_GO_OUTPUT='--- SKIP: database contract' expect_failure 'skip marker'
FAKE_GO_EXIT=0 FAKE_GO_OUTPUT='PASS' expect_failure 'generic PASS'
FAKE_GO_EXIT=0 FAKE_GO_OUTPUT='{"Action":"run","Package":"github.com/furia/shared-bookmark-sync/backend/internal/organizations","Test":"TestMigrationFrom000002ReconcilesLegacyPendingInvitations"}' expect_failure 'missing required package markers'

secret='postgres://user:password@db.example/contracts'
FAKE_GO_EXIT=1 FAKE_GO_OUTPUT="$secret" run_case
[[ $case_status -ne 0 ]] && [[ "$case_output" != *"$secret"* ]]

good_output='{"Action":"run","Package":"github.com/furia/shared-bookmark-sync/backend/internal/organizations","Test":"TestMigrationFrom000002ReconcilesLegacyPendingInvitations"}
{"Action":"pass","Package":"github.com/furia/shared-bookmark-sync/backend/internal/organizations","Test":"TestMigrationFrom000002ReconcilesLegacyPendingInvitations"}
{"Action":"run","Package":"github.com/furia/shared-bookmark-sync/backend/internal/groups","Test":"TestAddMemberRejectsUserOutsideOrganization"}
{"Action":"pass","Package":"github.com/furia/shared-bookmark-sync/backend/internal/groups","Test":"TestAddMemberRejectsUserOutsideOrganization"}
{"Action":"run","Package":"github.com/furia/shared-bookmark-sync/backend/internal/workspaces","Test":"TestCreateWorkspaceGrantsOnlyCreatorAdmin"}
{"Action":"pass","Package":"github.com/furia/shared-bookmark-sync/backend/internal/workspaces","Test":"TestCreateWorkspaceGrantsOnlyCreatorAdmin"}
{"Action":"run","Package":"github.com/furia/shared-bookmark-sync/backend/internal/httpapi","Test":"TestIdempotencyExecutorPostgresContracts"}
{"Action":"pass","Package":"github.com/furia/shared-bookmark-sync/backend/internal/httpapi","Test":"TestIdempotencyExecutorPostgresContracts"}'
FAKE_GO_EXIT=0 FAKE_GO_OUTPUT="$good_output" FAKE_GO_CWD_FILE="$tmp/cwd" run_case
[[ $case_status -eq 0 ]] && [[ "$(<"$tmp/cwd")" == "$root/backend" ]] && [[ "$case_output" == *'CONTRACT_MARKER package=github.com/furia/shared-bookmark-sync/backend/internal/httpapi'* ]] && [[ "$case_output" != *'postgres://'* ]]

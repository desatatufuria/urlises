# Apply Progress: Admin Web Review Remediation v2

## Status

**Mode:** Standard. **Delivery:** `exception-ok` / `size-exception`.  
**Completion:** **13/13 tasks complete**.

## Units 1–4 Evidence

| Unit | Evidence |
|---|---|
| 1 | Production migration reconciliation and recorded-history fix-forward passed **3/3** focused migration regressions with 0 skips. |
| 2 | Authorized target-bound replay covers five creation routes, revocation without DTO disclosure, target isolation, mismatch, reclaim, and concurrency. Focused evidence passed **11 top-level tests and 11 subtests**, 0 skips. |
| 3 | The fail-closed PostgreSQL gate validates four named JSON run/pass markers, rejects skips and fake output, and passed its shell harness and gateway run with 0 skips. |
| 4 | Panic recovery preserves committed responses, request IDs are UUID-only, optional response-writer interfaces are capability-faithful, and cleanup logs a generic event only. Focused evidence passed **5 top-level tests and 6 subtests**, 0 skips. |

## Unit 5 Evidence

| Evidence | Result |
|---|---|
| Key lifecycle | `useUncertainCreationKey` normalizes string intent, retains a key for uncertain/non-API failures, clears it on confirmed response or cancel, and creates a new key for changed intent. API errors clear a retained key. |
| Production mutation wiring | Invitation, group, group-member, and workspace creation mutations use the hook and pass keys to the existing POST wrappers. PATCH/PUT/DELETE wrappers remain without `idempotencyKey`; group-grant PUT remains visibility-only. |
| Group-grant visibility | `useGrantGroupWorkspaceAccessMutation` invalidates `queryKeys.workspace(workspaceId).access`; `AccessPage` consumes the refetched snapshot and renders group grants/effective sources without navigation. |
| Unchanged verification dependencies | `admin-web/src/features/access/AccessPage.tsx`, `admin-web/src/features/access/AccessPage.test.tsx`, and the relevant API wrappers/client tests were existing verification dependencies; they provided the group-grant visibility and keyless non-POST coverage in the 8-file/28-test suite and were not changed by Unit 5. |
| Admin-web verification | `npm run typecheck` passed. `npm run test -- --run` passed: **8 files / 28 tests**, 0 skipped; only React Router future-flag warnings. `npm run build` passed. |
| Backend verification | An unconfigured `go test ./...` failed as designed because DB-backed tests require URL variables. The rerun with all gateway URLs passed every package, followed by `go build ./cmd/api`. |
| Database gate | Gateway gate passed four markers: organizations, groups, workspaces, and httpapi. The shell harness also passed. |
| Genesis inventory | Actual Unit 5 change inventory is exactly five paths: `admin-web/src/lib/api/useUncertainCreationKey.ts`, `admin-web/src/lib/api/useUncertainCreationKey.test.ts`, `admin-web/src/features/groups/mutations.ts`, `admin-web/src/features/members/mutations.ts`, and `admin-web/src/features/workspaces/mutations.ts`. Every path appears in Design § Expanded Future Review Genesis Paths. No raw-index baseline comparison or review operation was used. |
| Rollback | Revert the hook/test and the three creation-mutation files together. Existing backend creation routes and group-grant PUT behavior remain unchanged. |
| Size | A precise full-v2 authored count is not safely derivable from the real index because its untracked baseline is excluded; the approved `size:exception` remains the governing boundary. |

## Task State

- [x] 1.1–1.2
- [x] 2.1–2.3
- [x] 3.1–3.2
- [x] 4.1–4.2
- [x] 5.1–5.4

## Remaining Work

Implementation is complete. Any review operation is **parent-owned**; no review/start, review-store, Git, commit, PR, archive, SMTP, or accidental-lineage action was performed.

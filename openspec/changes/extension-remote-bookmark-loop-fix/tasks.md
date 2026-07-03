# Tasks: Extension Remote Bookmark Loop Fix

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 220-360 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Narrow remote bookmark loop remediation | Single PR | Gitflow follow-up branch; include tests and docs |

## Phase 1: Foundation

- [x] 1.1 In `extension/src/background/projection.ts`, add the pending remote bookmark op types/state needed to correlate remote update and move apply per workspace/bookmark.
- [x] 1.2 In `extension/src/background/projection.ts`, add helpers to match remote change payloads, match remote move payloads, expire stale ops, and clear only the matched half.
- [x] 1.3 In `README.md` or `docs/roadmap.md`, note the Gitflow follow-up scope and that this remediation is limited to remote bookmark update/move loop prevention.

## Phase 2: Core Runtime Remediation

- [x] 2.1 In `extension/src/background/projection.ts`, update `applyRemoteBookmarkUpsert()` to register the pending remote op before `updateNode()`/`moveNode()` and preserve cursor context.
- [x] 2.2 In `extension/src/background/projection.ts`, update `handleBookmarkChanged()` so equivalent remote `onChanged` side effects are swallowed and do not call backend mutation APIs.
- [x] 2.3 In `extension/src/background/projection.ts`, update `handleBookmarkMoved()` so equivalent remote `onMoved` side effects are swallowed while non-matching events still use current local-mutation logic.
- [x] 2.4 In `extension/src/background/projection.ts`, verify final parent/index after remote apply and stop repeated same-bookmark retries once subtree/workspace recovery has started.
- [x] 2.5 In `extension/src/background/bookmark-listeners.ts`, keep the listener contract explicit for projection correlation needs without broad listener disable behavior.

## Phase 3: Focused Verification

- [x] 3.1 In `extension/tests/projection-behavior.test.mjs`, add coverage for spec scenario: remote `bookmark.updated` emits `onChanged` but is not re-sent to the backend.
- [x] 3.2 In `extension/tests/projection-behavior.test.mjs`, add coverage for spec scenario: remote move emits `onMoved`, preserves final parent/index, and does not loop back as a local move.
- [x] 3.3 In `extension/tests/projection-behavior.test.mjs`, add coverage for combined remote update+move so each suppression half is consumed independently.
- [x] 3.4 In `extension/tests/projection-behavior.test.mjs`, add coverage for bounded recovery so repeated equivalent retries are abandoned and degraded state appears only on true unrecoverable failure.

## Phase 4: Manual Validation

- [x] 4.1 On the Gitflow follow-up branch, manually replay a remote bookmark title/URL update in Chromium and confirm no duplicate backend mutation is emitted.
- [x] 4.2 Manually replay a remote bookmark reorder/move in Chromium and confirm final Chrome ordering matches backend order without repeated churn or premature degraded state.
- [x] 4.3 Update `docs/roadmap.md` or `README.md` with the validation note and branch/documentation status for this runtime remediation.

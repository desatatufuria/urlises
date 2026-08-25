# Proposal: Normalization-Aware Remote-Create Ownership Verification

## Intent

A real customer workspace ("Jira", SINGULARBANK) is permanently stuck at `pauseReason: "ambiguous-operation"`, `failedCursor: 11`, on a remote create of `https://pruebs`. `finishRemoteCreate` (`extension/src/background/projection.ts:1758-1769`) verifies the created node with `node.url !== ownership.url` — an exact string compare between the raw URL sent to Chrome and the value Chrome stores after normalizing bare origins (`https://pruebs` → `https://pruebs/`). The mismatch is deterministic and unrecoverable. Because `applyRemoteEnvelope`'s pause gate is workspace-wide, this one create blocks every later event for the workspace (confirmed: a later, correctly-terminated bookmark also never synced).

Same class of defect as `extension-sync-pause-recovery` fixed in `callbackMatches`, but in a separate function operating on CREATE ownership instead of UPDATE/MOVE receipts.

## Scope

### In Scope
- Make `finishRemoteCreate`'s URL check normalization-aware, reusing `canonicalUrlForComparison` from `convergence.ts` (no second canonicalizer). `parentId`/`index`/`title` stay exact-match; `url: undefined` (folder creates, which share this function) must remain equal to `undefined`.
- Clear stale non-`done` ownership operations in `rebuildJournal` (`convergence.ts:105-108`) so already-stuck installs recover. **This is required, not optional** — see Approach.
- Regression tests: bare-origin create, folder create, genuine mismatch still pauses, rebuild clears a stuck `started` operation.

### Out of Scope
- `startRemoteCreate` admission/overflow logic; the `createBookmark(...)` call at `projection.ts:1438` stays byte-identical (canonicalization is comparison-only).
- Backend and admin-web changes; reconciliation-model redesign.
- Re-litigating WHATWG `new URL().href` as the canonical basis (inherited from the prior change's ADR-002).

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `extension-sync-convergence`: final-shape verification of remote creates compares URLs modulo Chrome normalization; repair/rebuild must discard non-terminal create ownership.

## Approach

1. Import `canonicalUrlForComparison` into `projection.ts`; replace `node.url !== ownership.url` with a normalization-aware, `undefined`-safe comparison. Other fields unchanged.
2. `rebuildJournal` additionally drops operations whose `status !== "done"`, mirroring the prior change's ADR-005 treatment of `localIntents`.

Step 2 is mandatory because the stuck state is **not** self-healing:
- `rebuildJournal` spreads `...journal`, so `operations` survive rebuild untouched.
- `normalizeJournal` (`convergence.ts:25`) re-pauses with `ambiguous-operation` whenever any operation is `status: "started"`, and runs on every state read (`shared/storage.ts:89`).
- On replay the mapping is already set (`projection.ts:1448-1450`), so the create branch is not re-entered and `finishRemoteCreate` never runs again — the operation can never reach `done` on its own.

Without step 2, shipping the fix leaves every already-affected user permanently paused.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `extension/src/background/projection.ts` | Modified | `finishRemoteCreate` URL verification |
| `extension/src/background/convergence.ts` | Modified | `rebuildJournal` clears non-`done` operations |
| `extension/src/background/__tests__/` | Modified | Regression coverage |

Estimated size: well under the 400-line review budget (two predicates plus tests).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `canonicalUrlForComparison` absent from base branch | Resolved | Branch was rebased onto `fix/extension-sync-pause-recovery`'s tip before this proposal was finalized; helper confirmed present |
| Over-normalizing hides a genuine wrong-URL create | Low | Comparison-only; canonicalization never mutates stored/sent values |
| Rebuild clearing `started` operations drops in-flight work | Low | Rebuild already implies replay from checkpoint; only non-terminal entries are dropped |
| Chrome normalization affects fields beyond `url` | Low | Evidence isolates URL; `title`/`index`/`parentId` stay exact |

## Rollback Plan

Single revert of the change branch. No persisted-schema change: the fix only relaxes a comparison and prunes non-terminal journal entries, so reverting restores prior behavior. Users already paused would return to the stuck state and need a manual Rebuild after re-landing.

## Dependencies

- **Base branch**: `fix/extension-create-ownership-url-normalization` is stacked on `fix/extension-sync-pause-recovery` (not `develop`), because it reuses `canonicalUrlForComparison`. Each fix stays its own atomic, independently revertible commit; when the first fix merges to `develop`, this branch rebases cleanly on top (chain strategy: `stacked-to-main`, matching this session's established chained-PR pattern). Confirmed present on this branch's tip.

## Success Criteria

- [ ] A remote create of a bare-origin URL completes, marks the operation `done`, and leaves the workspace `live`.
- [ ] Folder creates (`url: undefined`) still verify successfully.
- [ ] A genuine parent/index/title/URL mismatch still pauses with `ambiguous-operation`.
- [ ] Rebuild on a journal holding a `started` create operation clears it and does not re-pause on the next state read.
- [ ] The affected workspace advances past cursor 11 and syncs subsequent events.

## Proposal question round — resolved by orchestrator

1. **Recovery path for affected users**: manual Rebuild, same as the prior change. No auto-repair-on-upgrade — that would be new scope (an unrequested resilience feature), not this bugfix's job.
2. **Rebuild semantics**: confirmed safe. Every observed `kind: "delete"` operation in real production journals is synchronous and lands as `status: "done"` immediately (`chrome.bookmarks.remove` is fire-and-confirm, no async ownership-verification step like create's re-read). Only `kind: "create"` operations are ever observed sitting in `"started"`. Design must cite this explicitly (the exact code path that marks delete operations done) rather than merely assume it.
3. **Blast radius of the pause gate**: confirmed out of scope. Keep the workspace-wide pause gate as designed; this change only fixes the false-positive trigger, exactly as scoped.
4. **Branch base**: confirmed — stacked on `fix/extension-sync-pause-recovery`, resolved above.

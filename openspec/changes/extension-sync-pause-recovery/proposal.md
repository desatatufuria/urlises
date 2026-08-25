# Proposal: Fix permanent sync pause caused by URL-normalization mismatch

## Intent

Production incident (SINGULARBANK / "Jira" workspace). A bare-origin bookmark URL (`https://admin.com`, no path) is stored by Chrome as `https://admin.com/`. The receipt signature is built from the raw URL and compared by exact string equality, so the receipt can never be proven. The workspace pauses permanently, and `applyRemoteEnvelope` then silently drops *every* later event for that workspace — not just the poisoned bookmark. Rebuild replays from cursor 0 and re-fails identically. Root cause cited in `exploration.md`.

## Scope

### In Scope
- Canonicalize URLs so signature matching survives Chrome's normalization. Exploration direction (a) or (b) — design picks the placement (canonicalize at signature build vs. normalization-aware comparison); either, not both.
- Guard the phantom local-edit intent: the update branch calls `updateNode` unwrapped, unlike the create branch's `withSuppression`, so a failed match queues the extension's own write as a "user edit" pushed to the backend on unpause. Minimal fix: mirror the create branch. Included as a data-integrity risk in the same code path; design may split it out with an explicit note if materially riskier than expected.
- Bare-origin regression coverage.

### Out of Scope
- **Force-unpause / operator escape hatch** (direction d) — distinct feature, own UX/authz questions. Suggested follow-up.
- **Reconciliation redesign** (direction c: state-diff vs. sequential replay-from-genesis). Too large; not required here.
- Backend changes — it correctly relays the URL string it was given.
- Pause/unpause UI, Retry-vs-Rebuild disposition, automatic retry scheduling.
- Data migration or receipt-purge tooling.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `extension-sync-convergence`: signature/callback proof MUST treat Chrome-normalized URL forms as equivalent to the submitted form; a failed remote-update match MUST NOT queue the extension's own write as local intent.

## Approach

One canonicalizer, applied at a single layer so signature construction and callback comparison agree. Because replay reconstructs receipts deterministically from immutable historical events, this **self-heals every stuck workspace** on its next Rebuild — no migration.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `extension/src/background/convergence.ts` | Modified | `shapeSignature` / `callbackMatches` normalization awareness |
| `extension/src/background/projection.ts` | Modified | `applyRemoteBookmarkUpsert` update branch: signature source + `withSuppression` guard |
| `extension/src/background/*.test.ts` | New | Bare-origin regression tests |

## Operational Note

The code fix does **not** proactively un-stick live workspaces — no automatic retry exists. Each affected workspace needs one Rebuild click (user- or support-triggered) after release. Spec SHOULD assert convergence-on-next-Rebuild; actual customer recovery is an ops/support step, not code.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Canonicalizer misses another Chrome normalization (punycode, percent-encoding) | Med | Enumerate in design; prefer normalization-aware comparison over guessing every form |
| Over-broad canonicalization treats genuinely distinct URLs as equal | Low | Restrict to Chrome-applied forms; never mutate the value sent to the backend |
| Suppression guard masks a real concurrent user edit | Low | Mirror existing create-branch semantics exactly; no new suppression window |

## Rollback Plan

Single revert of the branch merge. No schema, persisted-format, or backend change; journals and receipts remain readable by the prior build. Reverting restores pre-fix behavior (workspaces re-pause) but corrupts nothing.

## Dependencies

None. Gitflow: `fix/extension-sync-pause-recovery` off `develop`. Size estimate: small, single PR, well under the 800-line budget.

## Success Criteria

- [ ] A bare-origin bookmark created/updated remotely converges without pausing.
- [ ] An already-paused workspace converges on the next Rebuild, with no migration.
- [ ] A failed remote-update match queues no phantom local intent.
- [ ] No backend or replay-architecture change in the diff.

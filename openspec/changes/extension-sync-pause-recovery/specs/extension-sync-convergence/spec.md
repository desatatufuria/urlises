# Delta for extension-sync-convergence

## ADDED Requirements

### Requirement: Suppressed Local Capture for Remote-Initiated Writes

A Chrome callback that identity-matches a pending receipt (same workspace, backend id, chrome id, and entity type) MUST NEVER be captured as a new local-edit intent, whether or not the callback's shape subsequently matches that receipt — this MUST hold structurally, as a property of how an identity-matched callback is reduced, not merely via best-effort suppression around the write call (suppression alone cannot cover this: the reduction that would otherwise misattribute the callback runs upstream of any suppression check). Programmatic Chrome API writes issued by the extension to apply a remote update (`chrome.bookmarks.update`) SHOULD additionally be wrapped in the same suppression mechanism already used for remote-initiated creates, as defense-in-depth for secondary paths (a duplicate callback, or a callback arriving after its receipt was pruned) that have no pending receipt to identity-match against. Neither the structural guarantee nor the defensive suppression may alter receipt matching, pause, or fail-closed sequencing for a genuine mismatch — they only prevent the write's own echo from being misattributed as a user edit.

#### Scenario: Successful update suppressed like create
- GIVEN a remote-initiated `chrome.bookmarks.update` call succeeds
- WHEN Chrome fires the resulting `onChanged` callback
- THEN no local-edit intent is queued from that write
- AND the pending receipt consumes normally if its signature matches

#### Scenario: Own write never misattributed on mismatch
- GIVEN a remote-initiated update's own resulting callback identity-matches a pending receipt but fails shape/signature match
- WHEN the callback is reduced
- THEN the extension's own write is never queued as local-edit intent
- AND the mismatch instead gates/pauses the workspace at that receipt's cursor, exactly as a genuine mismatch would, without fabricating a local edit

#### Scenario: Genuine local edit still captured
- GIVEN a Chrome callback has no pending receipt matching its identity
- WHEN the callback is reduced
- THEN it is captured as a local-edit intent, unchanged from today's behavior

#### Scenario: Rebuild discards stale local intents
- GIVEN a workspace's journal holds local intents queued while paused, some already acknowledged and some not
- WHEN the user triggers Rebuild
- THEN only already-acknowledged intents survive into the rebuilt journal
- AND no unacknowledged, pre-rebuild intent can later cause the freshly-rebuilt workspace to pause again

## MODIFIED Requirements

### Requirement: Complete Callback Proof

`onChanged` partial data MUST have complete-node read and durable last-acknowledged before-shape before consumption. `onMoved` MUST prove exact old/new parent/index and workspace. URL comparison MUST treat Chrome's own normalized form (e.g. an added trailing slash on a bare-origin URL) as equivalent to the submitted form; this equivalence applies ONLY to signature/comparison logic and MUST NOT change the value persisted in receipts, stored server-side, or sent in future create/update payloads. Title comparison MUST remain exact; no normalization applies to title. Hidden-field, signature, shape, mapping, or containment mismatch — other than a known URL-normalization equivalence — MUST NOT consume and SHALL queue observable intent.

(Previously: any URL difference, including a Chrome-added trailing slash on a bare-origin URL, was treated as an unresolvable mismatch and always queued as observable intent, permanently blocking convergence for any bare-origin URL.)

#### Scenario: Hidden URL differs
- GIVEN a title-only callback with unexpected complete-node URL
- WHEN receipt matching runs
- THEN it is not consumed and is queued

#### Scenario: Adversarial Chrome-like ID
- GIVEN workspaces reuse an equivalent Chrome-like ID
- WHEN a move callback arrives outside the receipt workspace root
- THEN it cannot match or affect the receipt workspace

#### Scenario: Bare-origin URL converges without pause
- GIVEN a bookmark applied remotely with URL `https://example.com` (bare origin, no path)
- WHEN Chrome's callback reports the normalized `https://example.com/`
- THEN the receipt is marked consumed, not left pending
- AND the workspace does not pause

#### Scenario: Genuine URL mismatch still queues
- GIVEN a callback's URL differs from the expected shape for a reason other than known normalization (e.g. a real concurrent edit)
- WHEN receipt matching runs
- THEN it is not consumed and is queued as observable intent, same as before this change

#### Scenario: Title normalization not applied
- GIVEN a callback's title differs from the expected shape by any amount, including trivial whitespace
- WHEN receipt matching runs
- THEN it is treated as a mismatch and queued, exactly as before this change

#### Scenario: Normalization never touches stored or sent values
- GIVEN a bare-origin URL is normalized for signature comparison
- WHEN the extension builds a receipt's expected shape or issues a create/update payload
- THEN the value stored and sent is the original submitted form, never the normalized form

#### Scenario: Stuck workspace self-heals on Rebuild
- GIVEN an already-paused workspace whose only pending receipt was caused by this exact bare-origin URL mismatch
- WHEN the user triggers Rebuild after the fix ships
- THEN the workspace converges to a live, unpaused phase with no manual data cleanup

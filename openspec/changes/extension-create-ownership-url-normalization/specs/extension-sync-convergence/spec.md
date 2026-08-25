# Delta for extension-sync-convergence

## ADDED Requirements

### Requirement: Complete Create Ownership Proof

`finishRemoteCreate` MUST prove the created node's final shape against its ownership record before marking the create operation `done`. `parentId`, `index`, and `title` MUST remain exact-match against the ownership record. URL comparison MUST treat Chrome's own normalized form (e.g. an added trailing slash on a bare-origin URL) as equivalent to the submitted `ownership.url`; this equivalence is comparison-only and MUST NOT change the URL value stored in the ownership record or sent in the original `createBookmark` call. A folder create's `url: undefined` MUST remain treated as equal to an observed node URL of `undefined`. Any other parent, index, title, or URL mismatch MUST still pause the workspace with `ambiguous-operation`, unchanged from today's behavior.

#### Scenario: Bare-origin create converges without pause

- GIVEN a remote create submitted with URL `https://pruebs` (bare origin, no path)
- WHEN `finishRemoteCreate` reads back the node and Chrome reports the normalized `https://pruebs/`
- THEN the create operation is marked `done`
- AND the workspace does not pause with `ambiguous-operation`

#### Scenario: Folder create still verifies with undefined URL

- GIVEN a remote folder create whose ownership record has `url: undefined`
- WHEN `finishRemoteCreate` reads back the created folder node, which also has no URL
- THEN the URL comparison treats both sides as equal
- AND the create operation is marked `done`

#### Scenario: Title mismatch still pauses

- GIVEN a remote create whose read-back node title differs from the ownership record's title by any amount, including trivial whitespace
- WHEN `finishRemoteCreate` verifies the final shape
- THEN the workspace pauses with `ambiguous-operation`, exactly as before this change

#### Scenario: Genuine parent, index, or URL mismatch still pauses

- GIVEN a remote create whose read-back node's parent, index, or URL differs from the ownership record for a reason other than known Chrome URL normalization
- WHEN `finishRemoteCreate` verifies the final shape
- THEN the workspace pauses with `ambiguous-operation`, exactly as before this change

### Requirement: Rebuild Discards Stale Ownership Operations

`rebuildJournal` MUST discard any journal operation whose `status` is not `"done"`, in addition to its existing receipt and local-intent pruning. This applies uniformly regardless of operation `kind`; in practice only `create` operations are ever observed sitting at a non-terminal status, because `delete` operations complete synchronously and always reach `status: "done"` immediately.

#### Scenario: Rebuild discards a stuck started create operation

- GIVEN a workspace's journal holds a create operation with `status: "started"` left behind by an ownership-verification mismatch
- WHEN the user triggers Rebuild
- THEN the stale `started` create operation is discarded from the rebuilt journal
- AND no leftover non-`done` operation can cause the freshly-rebuilt workspace to pause again with `ambiguous-operation`

#### Scenario: Stuck workspace self-heals on Rebuild with no manual cleanup

- GIVEN an already-paused workspace whose `pauseReason` is `ambiguous-operation`, caused by a stale `started` create operation from the pre-fix URL comparison
- WHEN the user triggers Rebuild after this fix ships
- THEN the workspace converges to a live, unpaused phase on the next state read
- AND no manual data cleanup beyond the Rebuild click is required

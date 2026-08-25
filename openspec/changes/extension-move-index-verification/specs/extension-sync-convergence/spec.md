# Delta for extension-sync-convergence

## ADDED Requirements

### Requirement: Chrome-Correct Destination Index for Same-Parent Forward Moves

When applying a remote move whose `parentId` is unchanged and whose desired final index is greater than the node's current index, the extension MUST issue `chrome.bookmarks.move` with `index: desired + 1`, not `index: desired`, to compensate for Chromium's pre-removal-coordinate interpretation of `destination.index` for same-parent moves (Chromium treats `index === oldIndex` and `index === oldIndex + 1` as a silent no-op, and otherwise lands one position earlier than the literal value passed). A same-parent move whose desired final index is less than or equal to the node's current index MUST NOT receive this adjustment. A cross-parent move (any move where `parentId` changes) MUST NOT receive this adjustment, regardless of index direction. This applies identically to folder moves (`applyRemoteFolderUpsert`) and bookmark moves (`applyRemoteBookmarkUpsert`), since both call sites share the same defect. The adjustment changes only the index argument passed to `chrome.bookmarks.move`; the receipt's `move` record, `sameMove`, and `callbackMatches` comparison logic remain unchanged and continue to require an exact match against the originally requested final index.

#### Scenario: Forward-by-one same-parent folder move converges (production incident)

- GIVEN a remote move requests folder `INTRO` from index 0 to index 1 under the same parent (workspace root `69096`)
- WHEN the extension issues the move to Chrome
- THEN it passes `index: 2`, not `index: 1`
- AND Chrome emits `onMoved` reporting the node landed at index 1
- AND the pending receipt is consumed and the workspace checkpoints past that cursor

#### Scenario: Forward-by-many same-parent move lands at the exact requested index

- GIVEN a remote move requests a node from index 0 to index 3 under the same parent
- WHEN the extension issues the move to Chrome
- THEN it passes `index: 4`
- AND the resulting `onMoved` reports the node at index 3, matching the receipt exactly

#### Scenario: Backward same-parent move is unchanged

- GIVEN a remote move requests a node from index 3 to index 1 under the same parent
- WHEN the extension issues the move to Chrome
- THEN it passes `index: 1` unmodified
- AND the resulting `onMoved` reports the node at index 1, matching the receipt exactly

#### Scenario: Cross-parent move is unchanged

- GIVEN a remote move requests a node moved to a different parent at index `n`
- WHEN the extension issues the move to Chrome
- THEN it passes `index: n` unmodified, regardless of the node's prior index
- AND the resulting `onMoved` reports the node at index `n`, matching the receipt exactly

#### Scenario: Bookmark moves get the same correction as folder moves

- GIVEN a remote move requests a bookmark (not a folder) forward within the same parent
- WHEN `applyRemoteBookmarkUpsert` issues the move to Chrome
- THEN the same forward-adjustment rule applies as for folder moves
- AND the resulting `onMoved` matches the receipt exactly

#### Scenario: Receipt verification machinery is untouched by the correction

- GIVEN a same-parent forward move whose Chrome-bound index has been adjusted per this requirement
- WHEN the resulting `onMoved` callback is matched against the pending receipt
- THEN `sameMove` and `callbackMatches` perform the same exact-match comparison as before this change, with no new tolerance or normalization introduced

#### Scenario: Stuck workspace self-heals on Rebuild

- GIVEN an already-paused workspace whose `pauseReason` is `chrome-effect-rejected`, caused by a same-parent forward move that previously produced a silent Chrome no-op
- WHEN the user triggers Rebuild after this fix ships
- THEN the replayed move now issues the corrected index, Chrome emits `onMoved`, and the receipt consumes
- AND the workspace advances past the stalled cursor with no manual data cleanup

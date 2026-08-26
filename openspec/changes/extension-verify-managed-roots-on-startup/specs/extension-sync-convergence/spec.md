# Delta for extension-sync-convergence

## MODIFIED Requirements

### Requirement: Verified Fail-Closed Sequencing

Workspace MUST checkpoint only after predecessor final-shape verification. Capacity, write, read, verification, promise, or ambiguity errors MUST cause no effect/checkpoint, pause, stop later live/replay cursor advancement, and retry the failed cursor. Replay at/below checkpoint MUST be refused.

Existence of a workspace's tracked managed roots (`rootChromeId`, `organizationChromeId`, `workspaceChromeId`) MUST be re-derived at every `ensureWorkspaceProjection` call — startup, login, and workspace-selection change alike — and MUST NOT be inferred solely from a live `chrome.bookmarks.onRemoved` event. This verification MUST run whenever bootstrap is not otherwise required, for both live and already-degraded workspaces. When any tracked root fails to resolve, the workspace MUST be routed through the same `resyncWorkspace` path used by reactive removal detection, carrying the identical disposition, attempt budget, and unacknowledged-intent veto. A workspace whose tracked roots all resolve MUST NOT be paused, MUST NOT have any repair-attempt counter incremented, and MUST NOT be rematerialized as a result of this check.

(Previously: fail-closed sequencing covered checkpoint/predecessor verification and cursor errors only; a workspace's managed-root existence was re-derived exclusively from a live `onRemoved` event, so a root deleted while no worker was running left the workspace silently and permanently stuck reporting live/degraded with no automatic path to detection.)

#### Scenario: Read failure at cursor zero

- GIVEN the node read fails while applying cursor zero
- WHEN a later live event or replay event arrives
- THEN it remains paused at zero with no later effect or advance

#### Scenario: Healthy workspace is untouched by verification

- GIVEN a selected workspace whose `rootChromeId`, `organizationChromeId`, and `workspaceChromeId` all resolve via `chrome.bookmarks.get`
- WHEN `ensureWorkspaceProjection` runs for that workspace
- THEN no pause is persisted, no repair-attempt counter changes, and no rematerialization is dispatched

#### Scenario: Dangling root detected without a live removal event

- GIVEN a workspace's tracked managed root no longer resolves and no `onRemoved` event was ever delivered for it
- WHEN `ensureWorkspaceProjection` next runs, whether from startup, login, or a workspace-selection change
- THEN the workspace is routed through the same `resyncWorkspace` path `handleBookmarkRemoved` uses, with the same disposition, budget, and unacknowledged-intent veto

#### Scenario: Already-degraded workspace gets a fresh rebuild attempt

- GIVEN a workspace already reporting `health: "degraded"` whose tracked managed root no longer resolves
- WHEN `ensureWorkspaceProjection` runs for that workspace on the next worker start
- THEN existence verification still runs and the workspace is routed through `resyncWorkspace` for a fresh, budget-counted rebuild attempt

#### Scenario: Reactive removal detection is unaffected

- GIVEN a live `chrome.bookmarks.onRemoved` event fires for a workspace's tracked managed root while a worker is running
- WHEN `handleBookmarkRemoved` processes the event
- THEN it detects and routes the removal through `resyncWorkspace` exactly as before, independently of the `ensureWorkspaceProjection` verification path

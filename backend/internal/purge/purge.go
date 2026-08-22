// Package purge holds the shared retention window for soft-deleted
// organizations and workspaces (design.md "Home of the window constant").
// Window is the single source of truth for two independent consumers:
//
//   - The Trash "days remaining" countdown: purgeAt is computed
//     server-side as deleted_at + Window by the Trash list queries
//     (organizations.ListDeletedOrganizations, workspaces.ListDeleted).
//   - The eventual scheduled purge sweep, which hard-deletes rows once
//     they age past Window. The sweep itself (Sweeper, Sweep, Run) is
//     added by a later unit; this file intentionally holds only the
//     constant, so the countdown and the sweep can never drift apart on
//     the interval they share, and slice 3 stays independently shippable
//     without slice 4.
package purge

import "time"

// Window is the recovery period a soft-deleted organization or workspace
// stays restorable before it becomes eligible for the purge sweep.
const Window = 30 * 24 * time.Hour

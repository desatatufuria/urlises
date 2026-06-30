## Exploration: shared-bookmark-sync-mvp

### Current State
The repository is still greenfield: there is no product code yet, only `docs/requeriments.md`, OpenSpec bootstrap, and devcontainer scaffolding. The requirements define a Go + PostgreSQL backend and a Manifest V3 Chrome extension, with the backend as source of truth and Chrome as a local projection.

The product intent is clear at a high level: synchronize only extension-managed bookmarks under one root folder, scoped by organization/workspace, with real-time fan-out to other clients. Industry-standard MVP shape for this category is: canonical backend tree, local browser projection, durable client installation ID, initial snapshot + realtime event stream, local↔canonical ID mapping, idempotent event ingestion, and origin filtering to avoid loops.

Important requirement gaps remain: no ordering/version contract beyond `eventId`, no reconnect cursor strategy, no exact auth flow for the extension, no policy for multi-workspace folder layout under the single root, and no clear behavior when a viewer edits local managed bookmarks or when users delete a mapped Chrome folder subtree manually.

### Affected Areas
- `docs/requeriments.md` — source of truth for product scope, sync semantics, API surface, and MVP boundaries.
- `openspec/config.yaml` — project constraints: hybrid persistence, modular backend, documented contracts, Gitflow, and documentation-first workflow.
- `.devcontainer/devcontainer.json` — confirms a Go-first workspace with Node/npm available for the extension toolchain.
- `.devcontainer/docker-compose.yml` — confirms containerized local development assumptions and backend-oriented environment.
- `openspec/changes/shared-bookmark-sync-mvp/exploration.md` — persisted exploration artifact for downstream proposal/spec/design work.

### Approaches
1. **CRUD source of truth + sync event log** — Store folders/bookmarks in normal relational tables, treat `sync_events` as an idempotent delivery/audit stream, and use `workspace/tree` + `sync/events?since=` + WebSocket fan-out for projection updates.
   - Pros: simplest MVP; aligns with current requirements; easy permission checks; easier soft deletes and tree queries; easier to debug than full event sourcing.
   - Cons: must define ordering/version rules explicitly; dual-write concerns unless event persistence is transactional with entity changes; replay story is weaker than pure event sourcing.
   - Effort: Medium

2. **Event-sourced sync engine** — Make the event stream the primary source of truth and derive bookmark trees from replay/materialized views.
   - Pros: strong audit trail; natural dedup/replay model; elegant fit for collaboration systems.
   - Cons: too much complexity for MVP; harder queries and permission enforcement; higher recovery and migration cost; overkill before product semantics stabilize.
   - Effort: High

### Recommendation
Use **Approach 1** for the MVP: relational domain tables as canonical state, plus a transactional sync-event log for deduplication and fan-out. Pair that with these product decisions before proposal/design: one durable `client_id` per browser install, one canonical root subtree per workspace under `Shared Bookmarks`, backend-issued monotonic sync cursor/version in addition to `eventId`, initial full snapshot from `GET /workspaces/:workspaceId/tree`, then realtime updates via WebSocket with replay from last acknowledged cursor after reconnect.

This is the industry-normal MVP path because it keeps collaboration semantics understandable while still using the proven browser-sync pattern: snapshot first, events second, backend authoritative, local mapping persisted in extension storage, and explicit origin suppression / remote-apply guards.

### Risks
- `eventId` deduplication alone is insufficient; without ordering/versioning, out-of-order `move/update/delete` events can corrupt local projections.
- Chrome bookmark IDs are local-only, and recursive folder deletes emit tricky listener behavior; the extension will need a robust mapping/index layer, not just a flat key-value map.
- Viewer permissions are underspecified at the browser layer: Chrome cannot make folders read-only, so local edits must be detected, rejected by the backend, and reconciled back to canonical state.
- Manifest V3 service worker suspension and reconnects make “real-time” unreliable unless the product defines cursor-based catch-up and periodic resync.
- The requirements partially overspecify tables/module names too early, but underspecify the hard product decisions that actually determine sync correctness.

### Ready for Proposal
Yes — but the orchestrator should tell the user that proposal/design must first lock five decisions: sync ordering/cursor model, workspace-to-folder layout under the single root, extension auth flow, reconciliation policy for unauthorized local edits, and subtree delete/recovery semantics.

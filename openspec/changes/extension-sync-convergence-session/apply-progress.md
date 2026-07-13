# Apply Progress: Extension Sync Convergence Session

## Cumulative Status

20/24 tasks complete: PR1a–PR2b remain complete; PR3 tasks 7.1–7.2 are complete. Delivery remains stacked-to-`develop`, no `size:exception`.

## PR3 Dormant Journal

- [x] 7.1 RED: `convergence.test.mjs` first failed because the pure module did not exist; it now proves deterministic IDs, mapping-bijection pause, managed-root-only delete planning, latest-only epoch scheduling, caps, migration, and restart ambiguity.
- [x] 7.2: Added a version-1 per-projection journal and normalization. Legacy projections hydrate an idle journal; started operations hydrate paused as `ambiguous-operation`. The pure planner/scheduler has no projection, resync, or listener call site, so `convergent_projection` remains off and legacy behavior is unchanged.

## Work Unit Evidence

| Evidence | Exact result |
|---|---|
| RED | `cd extension && npm run build && node --test tests/convergence.test.mjs`: failed `ERR_MODULE_NOT_FOUND` for `dist/background/convergence.js`. |
| Focused GREEN | Same command: PASS, 4/4. |
| Storage/projection | `node --test tests/convergence.test.mjs tests/storage-serialization.test.mjs tests/projection-behavior.test.mjs`: PASS, 40/40. The persistent fake storage restored a started operation as paused. |
| Auth transport | `node --test tests/auth-transport.test.mjs`: PASS, 6/6. |
| Typecheck/build | `npm run typecheck` and `npm run build`: PASS. |
| Runtime/manual | Fake storage restart is the runtime boundary; Chromium is N/A because the engine has no active call site. |
| Rollback | Remove `extension/src/background/convergence.ts` and journal types/normalization/tests; legacy projection behavior is otherwise untouched. |

## Next

PR3 review only. Do not start PR4a/PR4b.

# Proposal: Extension MV3 WebSocket Keepalive

## Proposal question round
- Assumption: target Chrome is v150, so Chrome 116+ WebSocket keepalive support is available and no legacy-browser fallback is needed in this delta.
- Assumption: scope stays extension runtime hardening only; this change does not redesign replay, backend sync contracts, or broader Work Unit 5 behavior.

## Intent
- Harden MV3 service worker lifecycle behavior so the extension can keep its realtime websocket path healthy during normal idle periods without depending on popup/options interaction, reloads, or startup recovery as the expected path.

## Scope
### In Scope
- Add a narrow service-worker keepalive strategy around the existing websocket session.
- Define idle/reconnect behavior so remote events continue arriving during expected inactive browser periods.
- Keep diagnostics/documentation quiet and focused on true failure states.

### Out of Scope
- Sync architecture redesign, backend event model changes, or generic Work Unit 5 hardening.
- Expanding user-facing diagnostics beyond what is needed to confirm unhealthy runtime behavior.

## Capabilities
### New Capabilities
- `extension-runtime-liveness`: MV3 service worker keepalive, websocket longevity, idle continuity, and quiet failure signaling for the extension background runtime.

### Modified Capabilities
- None.

## Approach
- Keep the change extension-first on the current Gitflow follow-up path.
- Use Chrome 116+ compatible websocket keepalive traffic to prevent normal MV3 idle shutdown while a healthy session is expected.
- Reuse the current replay/reconnect ladder only as fallback when websocket health is genuinely lost.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `openspec/changes/extension-mv3-websocket-keepalive/proposal.md` | New | Formal delta proposal. |
| `extension/src/background/*` | Modified | Service worker lifecycle, websocket keepalive, reconnect, idle health handling. |
| `extension/src/shared/*` | Modified | Shared websocket/runtime helpers if keepalive coordination lives there. |
| `README.md`, `docs/roadmap.md` | Modified | Document MV3 keepalive scope, Gitflow intent, and validation expectations. |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Keepalive traffic creates noisy logs or visible churn | Med | Bound cadence, suppress normal-path diagnostics, log only unhealthy transitions. |
| Keepalive masks an app-level sync defect | Med | Keep success criteria limited to runtime liveness; preserve existing degraded/recovery signals. |

## Rollback Plan
- Revert the keepalive/lifecycle hardening path and return to the current websocket + replay/recovery behavior while keeping docs aligned with the rollback.

## Dependencies
- Chrome v150 runtime behavior, existing MV3 websocket path, and Gitflow documentation updates in the same slice.

## Success Criteria
- [ ] During normal idle periods, the websocket stays healthy without manual UI interaction.
- [ ] Remote events continue arriving without reload/startup being the normal recovery path.
- [ ] Keepalive does not degrade user experience or create noisy diagnostics during healthy operation.

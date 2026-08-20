```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:c0e48b30b29ce3dc26ff874a87d058f738821ed250a4bb9a8958890fd0bf4d2f
verdict: pass
blockers: 0
critical_findings: 0
requirements: 4/4
scenarios: 10/10
test_command: go test ./internal/config ./internal/organizations (+ full `go test ./...` re-run against an ephemeral Postgres 16 container)
test_exit_code: 0
test_output_hash: sha256:c0e48b30b29ce3dc26ff874a87d058f738821ed250a4bb9a8958890fd0bf4d2f
build_command: go build ./...
build_exit_code: 0
build_output_hash: sha256:01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b
```

## Verification Report

**Change**: invitation-email-delivery — PR 1 (backend slice only)
**Version**: N/A
**Mode**: Strict TDD

**Scope note**: This branch (`feat/invitation-email-delivery-backend`, targeting tracker `feat/invitation-email-delivery`) covers Phases 1–4, 7.1, 8.1 of `tasks.md` only. Phases 5, 6, 7.2, 7.3, and 8.2 (admin-web) are out of scope by explicit instruction and are excluded from this verdict. The `admin-web-invitation-acceptance` spec is therefore not evaluated here.

### Completeness (backend scope only)
| Metric | Value |
|--------|-------|
| Backend-scope tasks total (1.x, 2.x, 3.x, 4.x, 7.1, 8.1) | 20 |
| Backend-scope tasks complete | 19 |
| Backend-scope tasks incomplete | 1 (task 1.5, `.env.example` — see Correction below) |

**Correction to apply-progress.md**: apply-progress.md and tasks.md both record 1.5 as unchecked/blocked (sandbox permission denial for `.env.example`). Independent inspection of `/workspace/.env.example` shows the line **is present and correctly formatted**:
```
# Required when MAIL_ENABLED=true — used to build links in outgoing email
# (e.g. the invitation accept link). Must be a valid https URL with no
# query string or fragment; a trailing slash is trimmed automatically.
PUBLIC_BASE_URL=https://admin.urlises.lab.example.com
```
This matches the task's brief and D2's config contract exactly, placed adjacent to the `MAIL_*` block as required. The orchestrator's out-of-band edit (per the task framing) succeeded. `tasks.md`/`apply-progress.md` are stale on this one line and should be marked done before archive — a WARNING, not a CRITICAL, since the actual deliverable is correct.

### Build & Tests Execution
**Build**: PASS
```
cd backend && go build ./...   → exit 0, no output
go vet ./...                   → exit 0, no output
gofmt -l .                     → internal/sync/handler.go only (confirmed via `git status`/`git diff --stat` to be pre-existing/untouched by this change; zero files touched by this change are unformatted)
```

**Tests (no DB, re-run independently)**: PASS
```
go test ./internal/config ./internal/organizations
ok  	.../internal/config	   (all TestLoadPublicBaseURL/* subtests pass)
ok  	.../internal/organizations (all invitation_mail_test.go unit tests pass; DB-backed tests SKIP with the expected "set ORGANIZATIONS_TEST_DATABASE_URL..." message)
```

**Tests (real ephemeral Postgres 16, independently spun up in this session — not reused from apply-progress's evidence)**: PASS
```
docker run postgres:16-alpine on the sandbox's dtf-netwok bridge
go test ./internal/config ./internal/organizations -p 1 -parallel 1  → PASS, 27 test functions, including all 5 new DB-backed handler tests and both new service tests
go test ./...  -p 1 -parallel 1                                       → all 12 backend packages PASS (access, auth, bookmarks, config, database, groups, httpapi, mailer, organizations, sync, websocket, workspaces)
```
Container removed after the run. This independently reproduces the DB-backed evidence apply-progress.md claims, rather than trusting the claim.

**Coverage**: Not measured (no coverage tool run this session); apply-progress's assertion-quality/triangulation counts were spot-checked directly in test source (see below) rather than trusted blindly.

### Spec Compliance Matrix (backend-relevant specs only)

**`specs/invitation-email-delivery/spec.md`**
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Post-Commit Best-Effort Delivery | Invitation creation triggers a post-commit send | `handler_test.go > TestInvitationRouteInvokesNotifierOnceOnFreshCommand` | COMPLIANT |
| Post-Commit Best-Effort Delivery | SMTP failure does not fail invitation creation | `handler_test.go > TestInvitationRouteNotifierErrorStillReturns201` | COMPLIANT |
| Post-Commit Best-Effort Delivery | Idempotent replay does not re-trigger a send | `handler_test.go > TestInvitationRouteReplayDoesNotReinvokeNotifier` | COMPLIANT |
| Invitation Message Content | Message contains required fields | `invitation_mail_test.go > TestNotifyInvitationMessageContainsRequiredFieldsInBothBodies` | COMPLIANT |
| Accept Link Construction | Link built from configured public base URL | `invitation_mail_test.go > TestNotifyInvitationBuildsExactAcceptURLFromSpecScenario` | COMPLIANT |
| Accept Link Construction | Missing PUBLIC_BASE_URL fails config when mail enabled | `config_test.go > TestLoadPublicBaseURL/missing_when_mail_enabled` | COMPLIANT |

**`specs/organization-admin-control-plane/spec.md` (MODIFIED: Invite Lifecycle)**
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Invite Lifecycle | Accepted invite activates membership | `service_integration_test.go > TestAcceptInvitationActivatesMembershipAndRejectsReuse` | COMPLIANT |
| Invite Lifecycle | Reused or inactive invitation is rejected | same test (reuse branch) | COMPLIANT |
| Invite Lifecycle | New invitation stamped with 7-day expiry | `service_test.go > TestCreateInvitationSetsExpiryAndInviterContext` (asserts `now+168h ± 1min` skew) | COMPLIANT |
| Invite Lifecycle | Expired invitation rejected at accept time | `service_integration_test.go > TestAcceptInvitationRejectsExpiredInvite` | COMPLIANT |

**Compliance summary**: 10/10 backend-relevant scenarios compliant.

### Correctness — Deep-Dive on the Four Flagged Requirements

**1. Replay-safety (idempotent duplicate must not re-send)** — verified against actual code, not the apply-progress claim:
- `backend/internal/httpapi/idempotency.go:160-161`: `if found { return replayed, IdempotencyReplayed, nil, tx.Commit(ctx) }` — the `PostCommit` return value is a **literal `nil`** on replay, and this return happens *before* `prepared.Command(ctx, tx)` is ever called (line 163), so the closure that builds `invitationNotification(created)` is never constructed on a replay — not merely "not invoked," structurally unreachable.
- `handler.go:186-189`: the handler's only action is `if hook != nil { flush; hook(...) }`. A nil hook means this block is skipped entirely.
- Independently re-ran `TestInvitationRouteReplayDoesNotReinvokeNotifier` against a real Postgres instance in this session: two identical `POST` requests with the same `Idempotency-Key`, `notifier.count() == 1` after both. PASS.
- Fingerprint-conflict path (`TestInvitationRouteFingerprintConflictSendsNothing`) also independently re-run: a same-key/different-body second request returns 409 and the notifier count stays at 1 (i.e., zero additional sends). PASS.

**2. Mail failure never fails/rolls back invitation creation**:
- The `PostCommit` hook runs *after* `httpapi.WriteJSON` and `http.NewResponseController(w).Flush()` (`handler.go:185-189`), on `context.WithoutCancel(r.Context())`, with its error explicitly discarded (`_ = hook(...)`). The invitation row is already committed by `tx.Commit(ctx)` inside `ExecutePrepared` (`idempotency.go:170`) before the hook is even returned to the handler — so a send failure has no code path back to the transaction.
- `TestInvitationRouteNotifierErrorStillReturns201` independently re-run: notifier returns a synthetic error, response is still `201` with the created invitation body. PASS.
- `TestInvitationRouteWithDisabledMailerStillCreatesInvitation` uses the real `mailer.NewSMTP(config.MailConfig{Enabled:false})` (not a stub) wired through the real `MailInvitationNotifier`, confirming `ErrDisabled` end to end without touching the response. PASS.

**3. 168h expiry**:
- `service.go:102`: `const invitationTTL = 168 * time.Hour`.
- `service.go:426`: `expiresAt := time.Now().UTC().Add(invitationTTL)`, passed as `$6` on the INSERT.
- `TestCreateInvitationSetsExpiryAndInviterContext` asserts `expires_at` falls within `[before+168h-1min, after+168h+1min]` against a real row — re-run and PASS.
- Delta spec's `organization-admin-control-plane` requirement ("every invitation MUST be assigned an expiry of exactly 168 hours from creation") is satisfied; NULL semantics for pre-existing rows are untouched (no migration, no backfill), matching D1 and the design's Migration/Rollout section.

**4. CR/LF subject-line sanitization** (called out as correctness, not polish):
- `invitation_mail.go:139-142` (`sanitizeHeaderValue`) replaces `\r`/`\n` with spaces, collapses remaining whitespace, and trims — applied to `org` before it is interpolated into `subject` (`invitation_mail.go:81,87`).
- Confirmed against the actual downstream consumer: `internal/mailer/smtp.go:125` rejects any subject containing CR/LF via `safeHeader`, and `smtp.go:179` (`safeHeader`) is a plain `!strings.ContainsAny(value, "\r\n")` check — `sanitizeHeaderValue`'s output structurally cannot contain either byte, so `compose()` never rejects a sanitized subject regardless of organization-name content.
- `TestNotifyInvitationSanitizesCRLFInOrganizationNameForSubject` uses a header-injection-shaped payload (`"Acme\r\nBcc: attacker@evil.example"`) and asserts `!strings.ContainsAny(fake.message.Subject, "\r\n")`. PASS (both in isolated run and DB-backed full-suite run).

**5. `PUBLIC_BASE_URL` validation and presence in all three locations**:
- `config.go:27-40` (`AppConfig.Validate`): required when `mailEnabled`, rejects non-http(s) scheme, empty host, non-empty query/fragment — matches the design's `Validate` signature verbatim.
- `config.go:200-203`: wired into `Load` immediately after `mailConfig.Validate()`, exactly as designed.
- `docker-compose.yml:41`: `PUBLIC_BASE_URL: http://localhost:5173` — present.
- `docker-compose.prod.yml:34`: `PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://admin.urlises.lab.dtfuria.xyz}` — present.
- `.env.example:44`: `PUBLIC_BASE_URL=https://admin.urlises.lab.example.com`, correctly placed and commented — **present and correct**, contradicting the "not applied" status still recorded in `tasks.md`/`apply-progress.md` (see Completeness section above).
- `docs/deployment.md:42-45` and `docs/installation.md:89,93-97` both document the requirement and a manual Mailpit check.

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| `PublicBaseURL` on `AppConfig`, not `MailConfig` | Yes | `config.go:14-25` matches exactly. |
| `ExecutePrepared` + `PostCommit` for replay-safe delivery trigger | Yes | Verified structurally in `idempotency.go`, not just by test. |
| Synchronous hook after `WriteJSON`+`Flush`, on `WithoutCancel` context | Yes | `handler.go:186-189`, both idempotent and non-idempotent branches. |
| No extra send deadline; `MAIL_TIMEOUT` remains sole owner | Yes | No new timeout construct introduced in `invitation_mail.go`. |
| Message composition lives in `organizations/invitation_mail.go`, not `main` | Yes | Confirmed; `main.go` only constructs and injects. |
| `InvitationCreation` as a new struct, not an `Invitation` field extension | Yes | `service.go:107` (struct), `handler.go:19,27` (interface signatures). |
| Expiry computed in Go (`time.Now().UTC().Add`), not SQL `NOW()+INTERVAL` | Yes | `service.go:426`. |
| `idempotencyScope` reproduces `Execute`'s internal scope construction byte-for-byte | Yes | `handler.go:230-232`, matches `idempotency.go:119`'s inline scope literal field-for-field. |
| Notifier port stays unexported; only concrete type + constructor exported | Yes | `invitation_mail.go:37-56`. |
| Log only `invitation_id`/`organization_id`, never token/email/URL | Yes | `invitation_mail.go:66,69`; `TestNotifyInvitationLogsDisabledWithoutLeakingSecrets` asserts absence. |

### TDD Compliance
| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | Yes | Table present in apply-progress.md with RED/GREEN/TRIANGULATE/SAFETY NET per task group. |
| All tasks have tests | Yes | Config, service, invitation_mail, handler all have dedicated test files/functions. |
| RED confirmed (tests exist) | Yes | All listed test files verified present and containing the claimed test functions. |
| GREEN confirmed (tests pass) | Yes | Independently re-run against both no-DB and real-Postgres configurations in this session; all pass. |
| Triangulation adequate | Yes | Spot-checked: `invitation_mail_test.go` has 11 distinct test functions covering URL, required-fields, inviter-name variant, CR/LF, whitespace-collapse, HTML-escape, 3 logging variants, token-escape — genuine variance, not repeated trivial cases. |
| Safety Net for modified files | Yes | `TestLoadMailConfig`'s pre-existing "enabled" cases were updated with `PUBLIC_BASE_URL` in the same commit (apply-progress Deviation 4) — confirmed necessary and applied correctly; re-run passes. |

**TDD Compliance**: 6/6 checks passed

### Assertion Quality
Spot-checked `handler_test.go`'s 5 new tests and `invitation_mail_test.go`'s CR/LF test directly (not just apply-progress's claim): all assert on real production-code output (HTTP status codes, response bodies, notifier call counts via a real counting stub, and `strings.ContainsAny` against the actual composed `Message.Subject`). No tautologies, no empty-loop assertions, no smoke-test-only patterns found in the sampled files.

**Assertion quality**: All sampled assertions verify real behavior.

### Issues Found

**CRITICAL**: None.

**WARNING**:
- `tasks.md` (1.5) and `apply-progress.md` still record `.env.example` as unmodified/blocked, but the file on disk already has the correct `PUBLIC_BASE_URL` line. Update both artifacts to checked/done before archiving this slice, so the paper trail matches reality.

**SUGGESTION**:
- None beyond what's already tracked in design's "Open Questions" (out of scope here): `normalizeInvitation`'s unused `invitedByEmail` field, and the lack of resend/cancel/delivery-tracking — both explicitly out of scope by the proposal.

### Verdict
**PASS**

All backend-relevant spec requirements (4/4) and scenarios (10/10) are compliant with real, independently re-executed test evidence — including a from-scratch ephemeral-Postgres run in this session that reproduces every DB-backed test apply-progress.md claimed, plus a full 12-package `go test ./...` pass. `go build`, `go vet`, and `gofmt` are clean on every file this change touches (the one `gofmt` hit, `internal/sync/handler.go`, is pre-existing and untouched by this branch). The replay-safety and failure-isolation guarantees were verified structurally in `idempotency.go`/`handler.go`, not merely accepted from prior claims. The only discrepancy found is a paperwork lag (task/apply-progress checkboxes not reflecting that `.env.example` was in fact successfully patched) — a WARNING, not a blocker. **This backend slice is ready to be pushed and opened as PR 1**, contingent on updating `tasks.md`/`apply-progress.md`'s 1.5 checkbox for accuracy (non-blocking, can be done in the same push).

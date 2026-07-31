# NEOP — Build Plan & State

The full design rationale lives in the technical plan you supplied. This file tracks
**what is built, what is stubbed, and what needs a decision** — the honest delta.

## What is built and tested (Phase 0, directly on the pi SDK)

Pinned deps `@earendil-works/pi-agent-core@0.83.0` + `@earendil-works/pi-ai@0.83.0`.
39 passing tests, no key required (pi's faux provider drives the real loop).

| Component | File | Invariant it enforces |
|---|---|---|
| Reversibility gate + standing denials | `src/policy.ts` | §2.1 fail-closed, §8.3 non-overridable floor |
| Task contract loader | `src/taskSchema.ts` | §2.2 mandatory `successCheck`, §0 ≤6 tools, fail-closed classes |
| Ceilings | `src/ceilings.ts` | §2.3 checked before spend |
| Append-only audit | `src/audit.ts` | §4, never flips a decided verdict on write failure |
| Independent verifier | `src/verify.ts` | §6.1 cold context (pi-ai `completeSimple`, no tools), veto power, §12 anti-gaming |
| Model routing | `src/pi/config.ts` + `src/pi/provider.ts` | §7.4 provider/model behind env; `builtinModels()` + StreamFn bridge |
| Tool registry | `src/pi/tools.ts` | §0 broad surface, one action class per tool, real pi execution + stubs |
| The worker engine | `src/pi/worker.ts` | §5 admit→…→land on the pi `Agent`; gate in `beforeToolCall`, ceilings via `turn_end`+`abort()` |

Run it: `npm install && npm test`. Live smoke: `npm run dev:run -- tasks/smoke.yaml` (needs a provider key).

## What is deliberately stubbed (and why)

- **pi SDK binding — DONE.** The engine runs directly on pi's `Agent`; there is no
  adapter seam. Tests use pi's own faux provider at the `StreamFn` boundary.
- **Action tools** (`publish_post`, `send_email`, `internal_post`, `open_pr`,
  `merge_pr`, `deploy`, `purchase`) are registered with their correct action classes
  (so the loader admits them and the gate parks the irreversible ones) but **throw
  until wired behind the credential broker** (Phase 2+).
- **Adopted packages** (`pi-dispatch`, `pi-messenger`, `pi-web-access`, …) — **not
  installed.** Each is single-maintainer and holds credentials; per your own A.9,
  source-read + pin + vendor before it enters the path.
- **Control plane** (FastAPI): admission, credential broker, digest batching, approval
  PWA. The worker exposes the seams (`AdmissionCheck`, `ApprovalStore`) it plugs into.
- **Git worktree isolation** is modelled (the worker takes a `worktreeRoot`, scopes the
  tool `NodeExecutionEnv` to it, and jails writes via the gate) but the actual
  `git worktree add/remove` orchestration is control-plane.
- **Observability (§10) — dropped** at your request. No OTel/Grafana surface.

## Open decisions — these gate *running*, not the engine (§13)

The engine is built without them. They are needed before a live run:

1. **Which 4 tasks are the Phase 0–1 set?** Must be work you redo weekly and can write a
   `successCheck` for. This is the gating input for task authoring. `tasks/doc-sync.yaml`
   is a placeholder shape, not one of the four.
2. **Where does the worker run?** pi-dispatch's isolation assumes you own the Docker host.
3. **NEOP's GitHub identity** — recommended: a dedicated machine user, PR-only on real
   repos, never a human token. (Relevant now: the PAT you pasted must be revoked.)
4. **Model routing** — big model for the working turn, small for verification/triage,
   through your gateway so metering is real.
5. **Who owns `content/facts.md`?** Nothing in the content pipeline is safe until it exists.

## Phases (observability removed)

- **Phase 0 — Foundation. ✅ EXIT MET (2026-07-31).** Ten consecutive manual
  doc-sync runs, live model (gpt-5.2 doer / gpt-4o-mini verifier), in the
  container: runs 0940fe92…6e05465f all LANDED — 7 first-attempt, 3 recovered by
  the §6.3 task-failure retry (check [1,0] → verdict [False,True], failure output
  injected, model diagnosed, landed). Zero gate denies, zero blocks, ZERO writes
  outside the worktree across all ten. Transcripts read end to end (delegate
  review; trails in /data/journal.jsonl for operator spot-check). One earlier
  run (eadf398f) escalated on an UNPARSEABLE VERIFIER RESPONSE — work was
  correct, system failed closed as designed; streak restarted after it.
  Finding for later: re-ask the cold verifier once on parse failure before
  failing closed. Still open from the original Phase-0 list: pi-dispatch
  worktree orchestration, Supabase index.
- **Phase 1 — Verified autonomy. ▶ STARTED 2026-07-31.** All machinery in place:
  verifier ✅ successCheck ✅ circuit breaker ✅ §6.3 retry ✅. SCHEDULER ON
  (NEOP_SCHEDULER=1) in the live container: doc-sync daily 10:00, alert-triage
  weekdays 09:30 (laptop-realistic hours; misfires skip by design). Scheduled
  autonomy live-proven before enabling: two every-minute test fires each ran a
  REAL model run end to end (worktree → edits → check → cold verifier) and
  LANDED with zero human involvement.
  *Exit:* 2 weeks unattended, ≥90% success, veto rate <15%, zero interrupts for
  reversible work. Monitor: /metrics (vetoRate, breakers, spend) + the console
  timeline; every fire passes breaker → daily cap → §6.3 retry. The container
  must be running at fire time (Docker Desktop up, laptop awake).
- **Phase 2 — The gate.** ⬜ control-plane approvals, digest batching, PWA push, credential
  broker. `content-draft` runs drafts-only; `publish_post` not wired.
- **Phase 3 — Real-time actions.** ⬜ `publish_post` behind broker + idempotency + output
  scanning + capability separation (§8.1). Then one action tool at a time.
- **Phase 4 — Fleet.** ⬜ `pi-messenger` peer coordination; interview agent (built last, §9).

## Known gaps (audited 2026-07-30, in priority order)

1. ~~Console cannot trigger runs~~ — FIXED: `GET /tasks` + RUN A TASK panel.
2. ~~Approval reuse across runs~~ — FIXED: single-use approvals (§6.2), duplicate hard-deny.
3. ~~New-chat id collision~~ — FIXED: unique client ids.
4. ~~In-memory ledger/approvals~~ — FIXED: append-only JSONL journal + replay
   (src/server/journal.ts). Approvals incl. §6.2 consumption, parked runs, ledger,
   and chats survive kill -9 (proven cross-process). Resume republishes the exact
   persisted parked action, so post-restart approvals land cleanly.
5. **Resume re-executes the doer** — ~2× LLM tokens per gated task (documented in
   PERFORMANCE §4); Phase-2 fix: park-point persistence or plan→approve→execute.
6. **Live-mode cold ledger** — no seeding in live mode; mitigated by the trigger panel.
7. **Chat is deterministic** (ledger summaries, not an LLM) — fine for V1, say so in UI?
8. ~~Console has no auth~~ — FIXED: NEOP_ADMIN_TOKEN bearer auth on all API routes
   (/health open for health checks); console prompts once and stores the token.
9. ~~No global daily spend cap~~ — FIXED: NEOP_DAILY_TOKEN_CAP (default 1.2M),
   checked at admission before any spend, applies to resumes too; 429 with reason.
   Derived from the journaled ledger, so it survives restarts.
10. **Journal never rotates** — fine at V1 volume (~5-10 KB/run); rotation/eviction
   belongs to the Supabase phase.
11. **Deployment** — render.yaml + DEPLOY.md ship a single-service Render deploy
   (plane + console same-origin, disk-backed journal, token auth). Blocked only on
   rotating the exposed keys and clicking New → Blueprint.
12. ~~Circuit breaker missing / metrics.breakers hardcoded~~ — FIXED (§6.4): two
   consecutive task failures (veto/quarantine; declines don't count) trip it, new
   runs 423, POST /tasks/:id/breaker/reset re-arms (journaled, restart-proof),
   metrics reports real state and the console footer shows it.
13. ~~Live task loading 501~~ — FIXED: tasks/*.yaml load at boot (malformed files
   skipped loudly), listed via GET /tasks with source, runnable through the plane
   with verifier scope from the contract's own scope field.
14. ~~Retry policy (§6.3)~~ — BUILT: transient (network/5xx/rate-limit) retries
   ×3 with exponential backoff, same context; a red successCheck retries ONCE
   with the failure output injected into the prompt ("different context, not the
   same roll of the dice") on a fresh worktree; a verifier veto NEVER auto-retries.
   Retries are audit events on the run record.
15. ~~Scheduler/cron~~ — BUILT, OFF BY DEFAULT (NEOP_SCHEDULER=1): zero-dep
   5-field cron (steps/lists/ranges, vixie dom/dow OR-rule), fires tasks/*.yaml
   schedules through the normal admission path — breaker + daily cap guard every
   fire, refusals log and never crash, misfires skip (a 3am summary at 11am is
   noise). Off by default because unattended cron is something the Phase-0
   manual-runs discipline should EARN, not assume.

## Credential broker (§8.2) — BUILT

- Tools are credential-blind: they hand the broker (owner, runId, actionKey,
  params); the broker re-checks the approval INDEPENDENTLY, consumes the
  single-use key ATOMICALLY (consume-then-perform = at-most-once; a crash can
  burn a key, never double-send), scans output (§8.1 layer 4: placeholders,
  URL allowlist), resolves secrets per (owner, name), and performs.
- Consumption moved gate → broker: the gate's allow is advisory; the point of
  no return owns the idempotency. Journaled, restart-proof.
- Adapters: outbox (keyless default — JSONL receipts on /data), resend (real
  email, zero deps), webhook (real publish via Zapier/Make-style hooks).
- Live-proven: approve parked publish → broker performed → outbox receipt with
  the exact approved content; consumption journaled.
- Still ahead on this path: native platform adapters (LinkedIn/X APIs — need
  operator OAuth apps), per-client facts.md claim-check hook in the scan, and
  broker-over-HTTP when workers leave the process.

## Next concrete step

The pi binding is done. Next: set a provider key and do a live `npm run dev:run -- tasks/smoke.yaml`,
then author the real Phase 0–1 task contracts (decision #1) and add `pi-dispatch`
worktree orchestration so runs isolate on a host you own.

## From-scratch walkthrough (2026-07-31) — live browser session, real model end to end

Created two NEOPs from nothing (manual composition `acme/outbound`; Foreman chat
`acme/morning-ops`, later `zenith/daily-ops` through the full refuse→ground-truth→
landed-build loop) and drove them to consecutive landed runs. Four defects found
by RUNNING them, all fixed + tested (130 green):

1. **Standing-denial prose false-positive (P0)** — `no-destructive-sql` matched the
   bare word "update" in a summary's prose and denied the write. Now matches
   SQL-shaped patterns only (`UPDATE x SET` / `DELETE FROM x`). Regression tests added.
2. **Doer never saw its done-bar** — contract successCheck (and today's date, for
   `$(date +%F)` checks) now injected into the task description/system prompt.
3. **Foreman verifier framing** — verifier judged the Foreman against the spawned
   NEOP's job ("didn't write ops/summary.md"). Description now states the task is
   CREATE-AND-SPAWN. Live /build landed post-fix (12.5s, zenith/daily-ops).
4. **Tool path anchoring** — `path_prefix` frontmatter anchors read_brand_facts under
   ground-truth/ (model mis-pathing was 100% of remaining failures); re-anchors
   repo-root-style paths too.

Plus: registry-driven `## Dev fixture` sections — `neop dev` serves canned data for
unwired tools (crm_read), so a fresh NEOP rehearses its contract before credentials.

Performance (live gpt-5.2 doer / gpt-4o-mini verifier, in-container):
- acme/morning-ops: 3/3 landed, 8.4–9.7s
- acme/outbound (dev): 2/2 landed, ~21s
- zenith/daily-ops: 3/3 landed, 9.6–10.9s
- Foreman /build: refuse-with-instructions 9.9s; landed build 12.5s
- Anti-gaming caught for real: check passed on a cop-out artifact ("unable to
  generate…"), cold verifier vetoed it. The layered done-bar works.

## Full autonomy mode (2026-07-31) — operator-chosen, end-to-end hands-free

`NEOP_AUTONOMY=full` (env / compose): irreversible actions auto-approve — journaled
as approvedBy "autonomy:full" — and flow through the credential broker to the
configured adapter. This removes the WAIT, not the walls: worktree jail, standing
denials, ceilings, done-bar and verifier all still apply (they block disasters,
never completion). Default remains approval-gated.

Also: `native:` impl namespace — web_search now real (DuckDuckGo HTML, keyless,
results through the untrusted envelope). Live proof, zero human touches:
- acme/ai-brief: 20 refined web searches → source-cited brief → landed, 67.3s
- zenith/social (publish_post pinned): ground truth → 5 drafts → publish
  auto-approved → broker performed → outbox receipt with exact copy, 25.6s
Adapters still decide reality: outbox (default) = receipts; set
NEOP_ADAPTER_* + secrets to make sends/publishes real.

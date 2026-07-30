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

- **Phase 0 — Foundation.** ✅ worker core + invariants + tests + **pi SDK binding**
  (real `Agent` loop, tool registry, models, CLI smoke runner). ⬜ `pi-dispatch` worktree
  orchestration, Supabase index, 10 real manual runs of a task against a live key.
  *Exit:* 10 consecutive manual runs, transcripts read end to end, zero writes outside worktree.
- **Phase 1 — Verified autonomy.** ✅ verifier + successCheck + (⬜ circuit breaker, retry
  policy in control plane). Cron for two reversible in-repo tasks.
  *Exit:* 2 weeks unattended, ≥90% success, veto rate <15%, zero interrupts for reversible work.
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
14. **Retry policy (§6.3) not implemented** — no transient retry, no
   retry-once-with-failure-injected. Next candidate alongside the scheduler.
15. **Scheduler/cron not built** — prerequisites (cap, breaker) now exist; still
   deliberately manual-trigger until the Phase 0 exit (10 clean manual runs).

## Next concrete step

The pi binding is done. Next: set a provider key and do a live `npm run dev:run -- tasks/smoke.yaml`,
then author the real Phase 0–1 task contracts (decision #1) and add `pi-dispatch`
worktree orchestration so runs isolate on a host you own.

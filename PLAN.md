# NEOP — Build Plan & State

The full design rationale lives in the technical plan you supplied. This file tracks
**what is built, what is stubbed, and what needs a decision** — the honest delta.

## What is built and tested (worker core, Phase 0)

All runtime-agnostic, no key required, 39 passing invariant tests.

| Component | File | Invariant it enforces |
|---|---|---|
| Reversibility gate + standing denials | `src/policy.ts` | §2.1 fail-closed, §8.3 non-overridable floor |
| Task contract loader | `src/taskSchema.ts` | §2.2 mandatory `successCheck`, §0 ≤6 tools, fail-closed classes |
| Ceilings | `src/ceilings.ts` | §2.3 checked before spend |
| Append-only audit | `src/audit.ts` | §4, never flips a decided verdict on write failure |
| Independent verifier | `src/verify.ts` | §6.1 cold context, veto power, §12 anti-gaming |
| Run lifecycle | `src/lifecycle.ts` | §5 admit→isolate→…→land, honours all of the above |
| Runtime adapter seam | `src/runtime/*` | keeps pi SDK behind an interface (Appendix A.9) |

Run it: `npm install && npm test`.

## What is deliberately stubbed (and why)

- **pi SDK binding.** The engine talks to `AgentRuntime`; the real pi wrapper is added
  once the package is read + pinned (Appendix A.9). `FakeRuntime` stands in for tests.
- **Adopted packages** (`pi-dispatch`, `pi-messenger`, `pi-web-access`, …) — **not
  installed.** Each is single-maintainer and holds credentials; per your own A.9,
  source-read + pin + vendor before it enters the path.
- **Control plane** (FastAPI): admission, credential broker, digest batching, approval
  PWA. The worker exposes the seams (`AdmissionCheck`, `ApprovalStore`) it plugs into.
- **Git worktree isolation** is modelled (the lifecycle takes a `worktreeRoot` and jails
  writes to it) but the actual `git worktree add/remove` orchestration is control-plane.
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

- **Phase 0 — Foundation.** ✅ worker core + invariants + tests. ⬜ pi binding, worktree
  orchestration, Supabase index, one task (`doc-sync`) foreground/manual.
  *Exit:* 10 consecutive manual runs, transcripts read end to end, zero writes outside worktree.
- **Phase 1 — Verified autonomy.** ✅ verifier + successCheck + (⬜ circuit breaker, retry
  policy in control plane). Cron for two reversible in-repo tasks.
  *Exit:* 2 weeks unattended, ≥90% success, veto rate <15%, zero interrupts for reversible work.
- **Phase 2 — The gate.** ⬜ control-plane approvals, digest batching, PWA push, credential
  broker. `content-draft` runs drafts-only; `publish_post` not wired.
- **Phase 3 — Real-time actions.** ⬜ `publish_post` behind broker + idempotency + output
  scanning + capability separation (§8.1). Then one action tool at a time.
- **Phase 4 — Fleet.** ⬜ `pi-messenger` peer coordination; interview agent (built last, §9).

## Next concrete step

Answer decision #1 (the four tasks) — then I author their contracts + `successCheck`s,
and we build the pi `AgentRuntime` binding so a real (non-fake) run executes `doc-sync`.

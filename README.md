# NEOP — Autonomous Task Operator

NEOP runs recurring work unattended, stops on irreversible actions for a human, and
never lets an agent grade its own homework. Built **directly on the pi agent SDK**
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`), with a FastAPI control
plane and Supabase state to come.

> **Design contract:** broad tool surface, narrow task contracts. NEOP may hold
> dozens of tools; no single run gets more than six, and every run is judged by a
> command that exits 0.

## The three invariants (enforced in code, not prompts)

1. **Reversibility gate** — one question per action: *can a human undo this in five
   minutes?* Reversible → full auto with audit. Irreversible → block for a human.
   Unknown action classes **fail closed** (treated as irreversible).
2. **Machine-checkable done** — every task declares a `successCheck` shell command
   that must exit 0. The loader refuses any task without one. Run status comes from
   that command, never from the agent's claim.
3. **Ceilings in code** — token budget, sub-agent depth, wall-clock, action-rate —
   checked before spend, in the runtime and container.

Plus two non-negotiables: an irreversible action never happens without a human
decision, and **the verifier is never the doer** (a cold-context second session
judges every run).

## Repository layout

```
src/
  types.ts            core domain types
  taskSchema.ts       §2.2 task contract + successCheck enforcement (loader)
  policy.ts           §2.1/§8.3 reversibility gate + non-overridable standing denials
  ceilings.ts         §2.3 runtime ceilings, checked before spend
  audit.ts            §4 append-only JSONL audit trail
  successCheck.ts     §2.2 independent shell successCheck runner
  verify.ts           §6.1 cold verifier (pi-ai completeSimple, no tools, veto power)
  pi/                 the pi agent SDK binding
    config.ts         §7.4 model routing — provider/model behind env
    provider.ts       pi-ai models + the StreamFn bridge (builtinModels)
    env.ts            worktree-scoped execution context (NodeExecutionEnv)
    tools.ts          the NEOP tool registry on pi built-ins + stubbed action tools
    snapshot.ts       git-diff run artifacts
    worker.ts         §5 the engine: pi Agent + gate hook (beforeToolCall) + ceilings + verify
bin/
  run.ts              CLI smoke runner (one task against a git worktree)
tasks/
  doc-sync.yaml       reference Phase-0 task; smoke.yaml — live smoke task
tests/                invariant tests + worker.e2e (real worktree, faux model)
```

The three invariants attach to pi's real seams — no adapter indirection:
the reversibility gate + standing denials run in `Agent.beforeToolCall`; ceilings
count `turn_end` and call `agent.abort()`; "done" comes from an independent
`successCheck`; and a cold, tool-less verifier vetoes the result.

## Status

**Phase 0 — Foundation.** The worker is built directly on the pi agent SDK and runs
end-to-end: a real `Agent` loop drives the tool registry, the gate enforces the
invariants per tool call, git produces the diff, `successCheck` runs independently,
and the cold verifier vetoes. Tested with pi's faux provider (no key) on a real git
worktree. A live run needs only a provider key (`ANTHROPIC_API_KEY`, or set
`NEOP_PROVIDER`/`NEOP_WORK_MODEL`/`NEOP_VERIFY_MODEL`): `npm run dev:run -- tasks/smoke.yaml`.
Still to come: `pi-dispatch` worktree orchestration, Supabase index, the FastAPI
control plane, the credential broker, and wiring the stubbed action tools
(`publish_post`, `send_email`, …) — see `PLAN.md`.

## Security note

Credentials never live in the job container (§8.2 credential broker). Never paste a
token into a chat or commit one — see `.gitignore`. Rotate any exposed key before a
live run.

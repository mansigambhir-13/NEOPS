# NEOP — Autonomous Task Operator

NEOP runs recurring work unattended, stops on irreversible actions for a human, and
never lets an agent grade its own homework. Built on the pi agent SDK (behind an
adapter interface), a FastAPI control plane, and Supabase state.

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
  verify.ts           §6.1 independent verifier (cold context, veto power)
  lifecycle.ts        §5 run lifecycle: admit→isolate→assemble→execute→gate→verify→land→close
  runtime/
    AgentRuntime.ts   interface the pi SDK implements (adapter seam)
    fakeRuntime.ts    deterministic runtime for tests
tasks/
  doc-sync.yaml       example Phase-0 task (reversible, in-repo)
tests/                invariant tests — the reason to trust this at 3am
```

## Status

**Phase 0 — Foundation (in progress).** The worker core (three invariants, task
contract, policy gate, verifier, audit, lifecycle) is built and tested behind a
runtime interface. The pi SDK, `pi-dispatch`, Supabase, the FastAPI control plane,
and real action tools are **not yet wired** — see `PLAN.md` open decisions.

## Security note

Credentials never live in the job container (§8.2 credential broker). Never paste a
token into a chat or commit one — see `.gitignore`. Rotate any exposed key before a
live run.

# NEOP — Performance & Safety Report

Measured on Node v24.14.1, single machine. Reproduce: `npm test` (44 tests incl. 5
real-git E2E) and `npm run bench`.

## What this measures — and what it deliberately does not

NEOP's real per-task latency and cost are **dominated by the LLM**, which is stubbed
behind the `AgentRuntime` interface. Numbers like "seconds per task" and "₹ per run"
cannot be honestly quoted until the pi binding + a real model are wired. So this report
answers the questions that **do not** depend on a model:

1. Is NEOP's own orchestration ever the bottleneck? (No.)
2. Do the safety invariants hold, at speed and under concurrency? (Yes, 15/15.)
3. Does the whole thing actually run end-to-end on real infrastructure? (Yes — real
   git worktree, real shell `successCheck`, real diff.)

## 1. End-to-end integration (real, not mocked)

`tests/integration.e2e.test.ts` runs the full lifecycle against a throwaway git repo:

| Scenario | Result | What it proves |
|---|---|---|
| Happy path | **landed**; file changed on disk; real `grep` check exit 0 | the plumbing composes for real |
| Agent "claims done", real check RED | **not landed**, verdict fail | §2.2 — status comes from the machine check, not the agent |
| Out-of-scope test edit | **escalated**, `testsTampered` | §12.2 gaming caught on a real diff |
| Force-push probe | **hard-denied**, write never happens; legit work still lands | §8.3 floor holds mid-run |
| Publish probe | **awaiting_human** | §2.1 irreversible → human |

5/5 real runs pass. Wall time ~300 ms each — **entirely git subprocess spawns**, not engine.

## 2. Engine overhead (the number that matters)

| Metric | Result | Reading |
|---|---|---|
| Gate decision (§2.1) | **0.07 µs** · 13.4M/s | a policy decision is free vs a network call |
| Verifier static checks (§6.1) | **0.13 µs** · 7.5M/s | pre-model veto costs nothing |
| Full lifecycle, no LLM | **~0.004 ms/run** · 271k runs/s | admit→gate→verify→land is negligible |

**Interpretation:** a real run will spend seconds in the model and milliseconds in git;
NEOP's own logic is ~0% of wall time. The engine is nowhere near the critical path, so
reliability effort belongs in the verifier/gate *correctness*, not its speed.

## 3. Concurrency headroom (NFR4)

| Concurrent runs | Wall time |
|---|---|
| 5 (V1 target) | 0.04 ms |
| 50 (design target) | 0.17 ms |
| 200 | 0.83 ms |

The orchestrator is async and non-blocking; it holds no locks and no per-run threads.
The real concurrency ceiling is the **container pool + LLM spend cap**, enforced in the
control plane — never this code. NFR4 (5 now, 50 later) has orders of magnitude of slack.

## 4. Adversarial safety battery

15/15 attack vectors caught in **0.16 ms total**:

- force-push, force-with-lease, `reset --hard origin`, merge-to-main → **deny**
- `DROP TABLE`, `TRUNCATE`, unbounded `DELETE` → **deny**
- read `.env` / `id_rsa` → **deny**
- write outside worktree, egress to non-allowlisted host → **deny**
- unclassified tool, un-approved spend / external email / prod write → **block_for_human** (fail-closed)

Every irreversible or forbidden action is stopped **before** it executes, and the cost
of checking is sub-microsecond — there is no speed/safety trade-off to make here.

## Honest gaps (what these numbers do NOT cover)

- **No real model** → no true latency, cost, or task-success-rate. Those need the pi
  binding and a canary run (the next milestone).
- **Injection defence (§8.1)** is architectural (capability separation + human gate),
  not yet a measured detector — the battery tests the *floor*, not prompt-injection
  classification.
- **Prompt-injection through ingested content** remains the real risk; the gate limits
  *blast radius*, it does not *detect* injection. That is by design (§8.1 layer 3).

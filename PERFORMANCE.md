# NEOP — Performance & Safety Report

Single machine. Reproduce: `npm test` (39 tests incl. 7 real-git E2E) and `npm run bench`.

## What this measures — and what it deliberately does not

NEOP now runs directly on the pi agent SDK. Real per-task latency and cost are
**dominated by the LLM**, so "seconds per task" and "₹ per run" cannot be honestly
quoted without a live model run. The engine and safety floor, however, are exercised
for real: tests drive the actual pi `Agent` loop via pi's faux provider (no network),
so the gate, ceilings, tool execution, git diff, and verifier all run end-to-end.
This report answers the questions that **do not** depend on a model:

1. Is NEOP's own orchestration ever the bottleneck? (No.)
2. Do the safety invariants hold, at speed and under concurrency? (Yes, 15/15.)
3. Does the whole thing actually run end-to-end on real infrastructure? (Yes — real
   pi `Agent` loop, real tool execution, real git worktree, real shell `successCheck`.)

## 1. End-to-end integration (real, not mocked)

`tests/worker.e2e.test.ts` runs the full worker against a throwaway git repo, with the
doer's turns scripted by pi's faux provider:

| Scenario | Result | What it proves |
|---|---|---|
| Happy path | **landed**; file changed on disk; real `grep` check exit 0 | the plumbing composes for real |
| Agent "claims done", real check RED | **not landed**, verdict fail | §2.2 — status comes from the machine check, not the agent |
| Out-of-scope test edit | **escalated**, `testsTampered` | §12.2 gaming caught on a real diff |
| Force-push probe | **hard-denied** in `beforeToolCall`; legit work still lands | §8.3 floor holds mid-run |
| Publish probe | **awaiting_human** | §2.1 irreversible → human |
| Action ceiling | **aborts before the write**, lands flagged | §2.3 checked before spend |
| Admission rejects | **dropped** | breaker honoured |

7/7 real runs pass. Wall time ~1 s total — dominated by git subprocess spawns, not engine.

## 2. Engine overhead (the number that matters)

| Metric | Result | Reading |
|---|---|---|
| Gate decision (§2.1) | **~0.23 µs** · ~4.3M/s | a policy decision is free vs a network call |
| Verifier static checks (§6.1) | **~0.41 µs** · ~2.4M/s | pre-model veto costs nothing |
| Full worker, faux model | **~0.09 ms/run** · ~10.8k runs/s | admit→loop→gate→verify→land is negligible |

**Interpretation:** a real run spends seconds in the model and milliseconds in git;
NEOP's own logic is ~0% of wall time. Reliability effort belongs in the verifier/gate
*correctness*, not its speed.

## 3. Concurrency headroom (NFR4)

| Concurrent runs | Wall time |
|---|---|
| 5 (V1 target) | ~0.7 ms |
| 50 (design target) | ~5 ms |
| 200 | ~19 ms |

The orchestrator is async and non-blocking; it holds no locks and no per-run threads.
The real concurrency ceiling is the **container pool + LLM spend cap**, enforced in the
control plane — never this code. NFR4 (5 now, 50 later) has orders of magnitude of slack.

## 4. Adversarial safety battery

15/15 attack vectors caught in **<1 ms total**:

- force-push, force-with-lease, `reset --hard origin`, merge-to-main → **deny**
- `DROP TABLE`, `TRUNCATE`, unbounded `DELETE` → **deny**
- read `.env` / `id_rsa` → **deny**
- write outside worktree, egress to non-allowlisted host → **deny**
- unclassified tool, un-approved spend / external email / prod write → **block_for_human** (fail-closed)

Every irreversible or forbidden action is stopped **before** it executes (in
`Agent.beforeToolCall`), and the cost of checking is sub-microsecond.

## Honest gaps (what these numbers do NOT cover)

- **No live model run yet** → no true latency, cost, or task-success-rate. Those need a
  provider key and a canary run (`npm run dev:run -- tasks/smoke.yaml`).
- **Injection defence (§8.1)** is architectural (capability separation + human gate),
  not yet a measured detector — the battery tests the *floor*, not prompt-injection
  classification.
- **Prompt-injection through ingested content** remains the real risk; the gate limits
  *blast radius*, it does not *detect* injection. That is by design (§8.1 layer 3).

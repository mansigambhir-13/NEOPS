# NEOP — Backend Performance & Safety Report

All numbers measured on this machine (Node v24.14.1, macOS), on the merged pi-SDK
backend. Reproduce: `npm test` (58 tests), `npm run bench` (engine micro),
`node dist/bench/backend.js` (deep backend: subprocess + concurrency + HTTP).

## The measurement model

A run's wall time has four layers. Only the last one is NEOP's own code:

| Layer | Cost (measured p50) | Who pays it |
|---|---|---|
| LLM turns (live mode) | seconds | the provider — dominates everything |
| git subprocesses (worktree 214ms, snapshot 97ms) | ~300 ms/run | the OS (fork+exec+disk) |
| shell successCheck | ~8 ms | the OS |
| **NEOP engine** (gate, loop bookkeeping, verifier statics, ledger, HTTP) | **~0.04 ms** | us |

The engine is four orders of magnitude below the subprocess layer and six below the
LLM. **Optimization effort belongs in orchestration (overlap, reuse), never in the
engine.** That framing found one real bug — below.

## 1. Engine micro (verified, not inherited)

| Metric | Measured | Reading |
|---|---|---|
| Gate decision (§2.1) | 0.15 µs · 6.9M/s | a safety decision is free |
| Verifier static checks (§6.1) | 0.25 µs · 4.0M/s | pre-model veto costs nothing |
| Full worker, faux model, mocked subprocesses | 0.04 ms/run · 25k runs/s | pi `Agent` loop adds ~nothing |
| Adversarial battery | 15/15 denied in 0.39 ms | no speed/safety trade-off exists |

## 2. The finding: sync subprocesses serialized the whole control plane — FIXED

`gitSnapshot`, `ShellSuccessCheckRunner`, and worktree creation used `execSync`,
freezing the Node event loop for the duration of every git/shell call. The engine
bench never saw it (it mocks those layers — that blind spot is why `bench/backend.ts`
exists). Measured on full demo runs (real pi loop, real worktree, real check):

| Metric | execSync (before) | async execFile (after) | Δ |
|---|---|---|---|
| Max event-loop stall during a run | **237.8 ms** | **1.55 ms** | 153× |
| 2 concurrent runs (wall) | 798 ms — ratio 1.00 | 381 ms — ratio 0.56 | 2.1× |
| 5 concurrent (the NFR) | 1,987 ms — ratio 1.00 | 717 ms — ratio 0.42 | 2.8× |
| 10 concurrent | 3,942 ms — ratio 0.99 | 1,820 ms — ratio 0.53 | 2.2× |
| Single run p50 | 407 ms | 345 ms | 1.2× |

(ratio = wall / fully-serialized; 1.0 means every "concurrent" run queued behind a
frozen event loop — which also stalled every HTTP request up to ~240 ms.)

Remaining ratio > 1/K is genuine subprocess contention (fork + one disk), not event-
loop blocking; a run's own `add→diff→diff` chain is inherently sequential. At 50
concurrent runs the projected wall is ~7 s of overlapped work instead of ~20 s of
frozen process — and the plan's real answer at that scale is per-run containers
(pi-dispatch), not one Node process.

## 3. Control-plane HTTP (demo mode, 10 in flight)

| Route | p50 | p95 | Throughput |
|---|---|---|---|
| GET /runs ×300 | 1.36 ms | 2.75 ms | ~3,100 req/s |
| POST gate approve (includes a full worker **resume**) | 146 ms | — | — |

HTTP is never the bottleneck; the approve latency IS a worker re-execution (below).

## 4. Open findings (flagged, not yet fixed)

1. **Resume re-executes the whole run.** An approval re-invokes `runWorker` from
   scratch. Free in demo (146 ms); in live mode a gated task pays its doer tokens
   **twice** (~2× LLM cost for every human-gated run). Fix direction for Phase 2:
   persist pi `Agent` state at the park point and continue, or restructure gated
   tasks as plan → approve → execute so the expensive half runs once. Until then:
   budget gated tasks at 2× in the §2.3 ceilings.
2. **Ledger is unbounded in memory.** ~5–10 KB/run (events + task copy) ⇒ ~100 MB at
   10k runs. Fine for V1 single-operator; the Supabase index phase should add
   eviction (keep terminal outcomes, drop event bodies after N days — matches the
   14-day quarantine GC rule).
3. **Cold start:** `dev:serve` runs `tsc` first (~3–4 s). Ship `dist/` or use a
   watcher in dev; irrelevant in production (systemd runs the built artifact).

## 5. Live canary — DONE (OpenRouter: gpt-5.2 doer, gpt-4o-mini verifier)

Routing: `NEOP_PROVIDER=openrouter NEOP_WORK_MODEL=openai/gpt-5.2
NEOP_VERIFY_MODEL=openai/gpt-4o-mini` (+ `OPENROUTER_API_KEY`).

| Run | Result | Wall | Tokens | Cost |
|---|---|---|---|---|
| smoke (CLI) | landed | ~5 s | 627 in / 29 out | $0.0015 |
| doc-sync (plane, live) | landed | 18 s | 2.0k | ~$0.01 |
| alert-triage (plane, live) | landed | 25 s | 2.0k | ~$0.01 |
| content-draft (plane, live) | parked → browser approve → resumed → **landed** | 1m 11s incl. human wait | 1.5k | ~$0.01 |

What the canary caught (each found by a real failure, then fixed):
1. **Audit-in-worktree**: the CLI wrote `.neop-audit.jsonl` inside the worktree and
   the verifier vetoed NEOP's own bookkeeping as out-of-scope. Audit now lives
   outside the tree. The safety net caught the harness itself — working as designed.
2. **OpenRouter reasoning quirk**: `gpt-5-mini` / `grok-4.5` reject pi-ai's
   `completeSimple` ("reasoning is mandatory"); `gpt-5.2` / `gpt-4o-mini` work.
   Verifier routed to `gpt-4o-mini` ($0.15/M — cheaper anyway).
3. **Vague task contracts fail real models**: scripted-model-era descriptions
   ("regenerate the API doc") sent gpt-5.2 hunting through wrong filenames → veto.
   Precise contracts (exact paths, exact done-condition) land. §13.1 proven live.
4. **Tool surface too narrow**: content-draft had `edit_file` but no `read_file`;
   the model guessed file contents blind and failed. Contracts must include read.
5. **Resume re-park is correct security**: if the resumed model proposes *different*
   publish args than approved, the actionKey mismatches and a FRESH gate is raised
   (§2.1: changed content ⇒ new human look). Server + console now surface this
   instead of crashing; identical args resume straight through.

## Honest boundaries

Demo mode scripts the model text (pi faux provider) — everything else is real: pi
`Agent` loop, gate in `beforeToolCall`, worktrees, git evidence, independent
successCheck, cold verifier. Injection defence remains architectural (§8.1): the
gate bounds blast radius; it does not detect injection. That is by design.

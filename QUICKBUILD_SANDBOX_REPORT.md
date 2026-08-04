# Quick Build Sandbox Report

## Summary

This repository is **NEOP** (Autonomous Task Operator), a system for running recurring, unattended agent work safely. It is built directly on the pi agent SDK (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) and enforces three invariants in code rather than in prompts: a reversibility gate that blocks irreversible actions for human approval, machine-checkable "done" via independent shell `successCheck` commands, and hard ceilings (token budget, sub-agent depth, wall-clock, action-rate) enforced before spend. On top of the worker engine sits **Quick Build**, a markdown-based tool/template registry and worktree-per-run orchestration layer (with a self-hosting "Foreman" that can spawn new NEOPs from a stated requirement), plus a FastAPI-style control plane and Supabase-backed state planned for later phases.

## Main Components

- **`src/`** — core engine: `types.ts`, `taskSchema.ts` (task contract + successCheck enforcement), `policy.ts` (reversibility gate + standing denials), `ceilings.ts` (runtime limits), `audit.ts` (append-only JSONL audit trail), `successCheck.ts`, `verify.ts` (cold, tool-less verifier with veto power).
- **`src/pi/`** — the pi agent SDK binding: model routing (`config.ts`), provider/StreamFn bridge (`provider.ts`), worktree-scoped execution env (`env.ts`), the NEOP tool registry (`tools.ts`), git-diff run artifacts (`snapshot.ts`), and `worker.ts` (the engine loop tying gate + ceilings + verify together).
- **`src/quickbuild/`** — the Quick Build registry loader (parses/validates/merges markdown tool & template specs, taint × irreversibility refusal, version pinning).
- **`registry/`** — markdown registry of tools and templates plus a generated `INDEX.md`.
- **`bin/`** — CLIs: `neop.ts` (`neop index/check/resolve/build/promote`), `run.ts` (smoke runner), `serve.ts` (control-plane server).
- **`tasks/`** — example task contracts (`doc-sync.yaml`, `smoke.yaml`, `alert-triage.yaml`).
- **`neops/`** — spawned NEOP instances (e.g. `demo/`).
- **`tests/`** — invariant tests, worker end-to-end tests, guardrail/policy/scheduler tests.
- **`web/`** — a frontend (Vite-based) for the fleet/control UI.
- **`bench/`** — performance benchmarking scripts and reports (see `PERFORMANCE.md`).
- **Docs** — `README.md`, `QUICKBUILD.md`, `PLAN.md`, `DEPLOY.md`, `PERFORMANCE.md` documenting design, build phases, and deployment.

written from inside a Quick Build sandbox container.

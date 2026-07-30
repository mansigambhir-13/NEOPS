# Quick Build — build plan & state

Working from the v3 design (markdown registry, worktree-per-run, self-hosting
Foreman). This file records the design review findings, the phase plan, and what
is built. Quick Build does not rebuild the engine — it **feeds** the existing
worker (gate, verifier, ceilings, journal, control plane all inherited).

## Design review — findings folded into the build

1. **"Worktree isolation is real" is overstated.** A git worktree is a convenience
   boundary; nothing stops an absolute-path read into a sibling tree or another
   client's ground-truth. The gate jails *writes* today. → QB3 adds a read-jail.
2. **The taint model was declared, not enforced.** Now it is: the resolver REFUSES
   any toolset holding an untrusted-input tool AND an irreversible tool
   ("the NEOP wants to be two NEOPs" — §8.1 capability separation, in code). QB0 ✅
3. **`success_check` is shell in agent-writable markdown** — registry write access
   is code execution. Checks run only inside the jailed worktree; *scheduled*
   contracts require promotion (PR review). Spawn-now specs run on demand only.
4. **`extends` semantics defined**: unions for tool sets; **forbidden wins** —
   a bound+forbidden tool is a load error, never a silent drop. Cycles error. QB0 ✅
5. **Version pinning (v3 open decision #2): decided, in v1.** Resolution records
   `name → version` pins. QB0 ✅
6. **Class ↔ reversibility consistency**: a tool claiming `reversible: true` with
   an irreversible action class is refused — `policy.ts` stays the authority. QB0 ✅
7. **Warm pool cut from v1.** Measured in-process spawn is ~350 ms; there is no
   problem for a warm pool to solve yet.
8. **No `ask_human` tool.** Approvals are gate-native here (park → console →
   resume) — stronger than a tool the model may forget to call.
9. **Cron recorded, not scheduled.** Contracts carry `schedule` but v1 runs them
   on demand — the scheduler stays deliberately unbuilt (Phase-0 exit discipline).
10. **Registry class vocabulary maps onto the gate's enum** (`read_external → read`
    etc.) — one policy vocabulary, two spellings, loader translates. QB0 ✅

## Phases

| Phase | Scope | Gate | State |
|---|---|---|---|
| **QB0** | Registry loader: parse, validate, extends-merge, taint×irreversible refusal, pins, INDEX.md; `neop index/check/resolve` | loader suite green; `neop check` clean | ✅ 14 tests |
| **QB1** | Seed registry: 6 tools (incl. read-inbox verbatim) + base/coding/marketing | seeds load clean; taint rule provably blocks inbox+publish | ✅ |
| **QB2** | Spec + worktree runner: `spec.md` → resolve → `git worktree` under `.neop/worktrees/` → bind to existing `runWorker` → run a contract | one spec end-to-end, faux + live | ✅ |
| **QB3** | Tenancy hardening: gate read-jail, ground-truth write-deny, `<untrusted_content>` envelope on untrusted tool output | jail tests; cross-namespace read denied | ✅ |
| **QB4** | Foreman from `foreman.md`: pinned-ref boot (`git show ref:path`), runtime spawn/list/reap tools, `neop build` | Foreman spawns from a requirement; pinned ref survives a bricked working-tree foreman.md | ✅ |
| **QB5** | `neop promote` (commit; PR via gh), INDEX freshness in `neop check` | one NEOP, one commit | ✅ |

## Build log — what the tests actually prove

- **QB2**: spawn refuses without required ground truth; spawn stamps pins into the
  spec; the runner materialises a real `git worktree`, overlays uncommitted
  spec/ground-truth (local-first), runs the contract through the REAL worker
  (gate in beforeToolCall, independent shell check, cold verifier), reaps clean
  trees, keeps failed ones. Live irreversible calls PARK (the gate is still the
  gate); `neop dev` auto-approves visibly as "dev-mode" and stubs the irreversible
  tool — the devLog records what would have happened, nothing leaves the machine.
- **QB3**: read-jail denies cross-namespace reads; ground truth is agent-readable,
  agent-unwritable; the Foreman's write-allowlist confines it to registry/+neops/;
  untrusted tool output arrives wrapped in `<untrusted_content>` — in code.
- **QB4**: the Foreman (faux-scripted) reads INDEX, writes a spec, calls
  spawn_neop — and the spawn is real (pins stamped by the resolver). With the
  working-tree `foreman.md` deliberately bricked, `--from-ref <good-sha>` still
  boots — the self-hosting hazard is closed.
- **QB5**: `neop promote` = one NEOP, one commit.
- Bug the tests caught: `draft_post` declared `impl: builtin:edit_file` — its
  calls failed pi's param validation silently (no gate event at all). The debug
  trail (audit JSONL) found it in minutes; impl is the contract too.

## Built so far

- `src/quickbuild/registry.ts` — the loader. Pure functions, no model, no network.
- `registry/` — 6 tools, 3 templates, generated `INDEX.md`.
- `bin/neop.ts` — `neop index | check | resolve <template> [--with a,b]`.
- 14 loader tests (90 total in the repo).

The refusals are the product: a template binding `read_inbox` next to
`publish_post` does not get a warning — it does not resolve.

## v3 open decisions — positions taken

1. Registry ships shared; client-authored tools go to `registry/local/` (agreed
   with v3's recommendation; enforced when QB4 lands).
2. Tool versions pin per spec — done in QB0.
3. The Foreman refuses to spawn `marketing` without `facts.md` — QB4, enforced by
   `ground_truth.required` (already in the resolver output).

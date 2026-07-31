/**
 * QB2/QB4 — the worktree runner and the fleet.
 *
 * Nothing here re-implements the engine: a Quick Build run IS a `runWorker` run —
 * gate in beforeToolCall, independent successCheck, cold verifier, audit — with
 * three Quick Build twists:
 *   - the workspace is a real `git worktree` of THIS repo (shared objects, hard
 *     per-run tree), jailed to the NEOP's own `neops/<client>/<slug>/` dir
 *   - tools come from the markdown registry via the binder (builtin/runtime/stub)
 *   - QB3 jails are ON: readJail + ground-truth write-deny
 *
 * The Foreman (QB4) runs through the same door with two differences: it acts on
 * the MAIN working tree (writes confined to registry/ + neops/ + .neop/) and its
 * DEFINITION loads from a pinned git ref, never the working tree.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runWorker, type RunInput, type RunOutcome, type WorkerDeps } from "../pi/worker.js";
import type { TaskContract } from "../taskSchema.js";
import { JsonlAuditSink } from "../audit.js";
import { ShellSuccessCheckRunner } from "../successCheck.js";
import type { ResolvedModels } from "../pi/provider.js";
import { loadRegistry, loadRegistryFromRef, resolveTemplate, type Registry, type ResolvedTemplate } from "./registry.js";
import { loadSpec, specPath, writeSpec, type Spec } from "./spec.js";
import { bindRegistryTools, type RuntimeHandler } from "./bind.js";
import type { ActionRequest, RunArtifacts } from "../types.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// ---------------------------------------------------------------- worktrees

export function materializeWorktree(repoRoot: string, slug: string, runId: string): string {
  const dir = resolve(repoRoot, ".neop", "worktrees", `${slug.replace("/", "-")}-${runId}`);
  mkdirSync(resolve(repoRoot, ".neop", "worktrees"), { recursive: true });
  git(repoRoot, ["worktree", "add", "--detach", dir, "HEAD"]);
  return dir;
}

export function removeWorktree(repoRoot: string, dir: string): void {
  try {
    git(repoRoot, ["worktree", "remove", "--force", dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true }); // fallback; prune reconciles git
  }
}

// ---------------------------------------------------------------- spawn / fleet

export interface SpawnRequest {
  slug: string;
  template: string;
  owner: string;
  withOptional?: string[];
  charter?: string;
}

/**
 * Spawn = validate + pin + write the spec + register. Running happens via
 * runContract; a spec you can hold in a one-file diff is the product here.
 * Refuses when required ground truth is missing (v3 open decision #3: decided).
 */
export function spawnNeop(repoRoot: string, registry: Registry, req: SpawnRequest): { spec: string; pins: Record<string, string> } {
  const resolved = resolveTemplate(registry, req.template, { withOptional: req.withOptional ?? [] });
  const missing = resolved.groundTruth.required.filter(
    (f) => !existsSync(join(repoRoot, "neops", req.slug, "ground-truth", f)),
  );
  if (missing.length) {
    throw new Error(`ground truth missing for ${req.slug}: ${missing.join(", ")} — write it first (nothing in this template is safe without it)`);
  }
  if (existsSync(specPath(repoRoot, req.slug))) {
    throw new Error(`"${req.slug}" already has a spec — reap or promote it first`);
  }
  const spec = writeSpec(repoRoot, {
    slug: req.slug,
    template: req.template,
    owner: req.owner,
    withOptional: req.withOptional ?? [],
    pins: resolved.pins,
    ...(req.charter ? { body: req.charter } : {}),
  });
  // marker the Foreman's own contract checks (test -f .neop/last-spawn)
  mkdirSync(join(repoRoot, ".neop"), { recursive: true });
  writeFileSync(join(repoRoot, ".neop", "last-spawn"), `${req.slug}\n`, "utf8");
  return { spec, pins: resolved.pins };
}

export interface FleetEntry {
  slug: string;
  template: string;
  owner: string;
  worktrees: string[];
}

export function listFleet(repoRoot: string): FleetEntry[] {
  const out: FleetEntry[] = [];
  const neops = join(repoRoot, "neops");
  if (existsSync(neops)) {
    for (const client of readdirSync(neops, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const slug of readdirSync(join(neops, client.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const full = `${client.name}/${slug.name}`;
        try {
          const s = loadSpec(repoRoot, full);
          out.push({ slug: full, template: s.template, owner: s.owner, worktrees: [] });
        } catch {
          /* dir without a valid spec — skip */
        }
      }
    }
  }
  const wtRoot = join(repoRoot, ".neop", "worktrees");
  if (existsSync(wtRoot)) {
    for (const wt of readdirSync(wtRoot)) {
      const entry = out.find((e) => wt.startsWith(e.slug.replace("/", "-")));
      entry?.worktrees.push(wt);
    }
  }
  return out;
}

export function reapNeop(repoRoot: string, slug: string): { removed: string[] } {
  const wtRoot = join(repoRoot, ".neop", "worktrees");
  const removed: string[] = [];
  if (existsSync(wtRoot)) {
    for (const wt of readdirSync(wtRoot).filter((w) => w.startsWith(slug.replace("/", "-")))) {
      removeWorktree(repoRoot, join(wtRoot, wt));
      removed.push(wt);
    }
  }
  return { removed };
}

// ---------------------------------------------------------------- run a contract

export interface RunContractOptions {
  repoRoot: string;
  registryDir?: string;
  slug: string;
  /** contract id from the template; defaults to the first. */
  contractId?: string;
  models: ResolvedModels;
  /** v3 §8 dev mode: irreversible tools stubbed, log-and-succeed. */
  dev?: boolean;
  keepWorktree?: boolean;
}

export interface ContractRunResult {
  outcome: RunOutcome;
  worktree: string;
  auditFile: string;
  devLog: string[];
}

export async function runContract(opts: RunContractOptions): Promise<ContractRunResult> {
  const repoRoot = resolve(opts.repoRoot);
  const registry = loadRegistry(opts.registryDir ?? join(repoRoot, "registry"));
  const spec = loadSpec(repoRoot, opts.slug);
  const resolved = resolveTemplate(registry, spec.template, { withOptional: spec.withOptional });

  // pins drift check (open decision #2): a spec pinned against older tool versions
  // gets a loud warning in the outcome, not a silent re-resolve.
  const drift = Object.entries(spec.pins ?? {}).filter(([n, v]) => resolved.pins[n] && resolved.pins[n] !== v);

  const contract = opts.contractId
    ? resolved.contracts.find((c) => c.id === opts.contractId)
    : resolved.contracts[0];
  if (!contract) {
    throw new Error(`template "${spec.template}" has no contract${opts.contractId ? ` "${opts.contractId}"` : "s"}`);
  }

  const runId = Math.random().toString(36).slice(2, 10);
  const worktree = materializeWorktree(repoRoot, opts.slug, runId);
  const slugDir = join(worktree, "neops", opts.slug);
  mkdirSync(slugDir, { recursive: true });
  // local-first (v3 §4): a just-spawned spec + ground truth may be uncommitted —
  // overlay the working-tree slug dir onto the HEAD worktree so `neop dev` works
  // immediately after spawn, before any promote.
  const workingSlugDir = join(repoRoot, "neops", opts.slug);
  if (existsSync(workingSlugDir)) {
    cpSync(workingSlugDir, slugDir, { recursive: true });
  }

  const devLog: string[] = [];
  const bound = bindRegistryTools(resolved.tools, { ...(opts.dev ? { dev: true } : {}), devLog });

  const task: TaskContract = {
    id: opts.slug.replace("/", "-"),
    description: `${spec.body || `Run contract ${contract.id} of ${spec.template}.`}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.\nYour contract "${contract.id}" is done when this command exits 0: \`${contract.successCheck}\` (run from your working directory; $(date +%F) expands to today's date).`,
    systemPrompt: `${resolved.systemPrompt}\n\n---\n# This instance\n\n${spec.body}\n\n## Your contract\nDone means this exits 0: \`${contract.successCheck}\``,
    tools: resolved.tools.map((t) => ({ name: t.name, class: t.mappedClass })),
    successCheck: contract.successCheck,
    scope: opts.slug,
    ceilings: {
      maxTokens: resolved.resources.tokenBudget,
      wallClockMs: resolved.resources.wallClock * 1000,
    },
  };

  const input: RunInput = {
    runId,
    task,
    worktreeRoot: slugDir, // jail = the NEOP's own namespace, not the whole tree
    egressAllowlist: [...new Set(resolved.tools.flatMap((t) => t.egress))],
    logicalDate: new Date().toISOString().slice(0, 10),
    readJail: true, // QB3: tenancy — reads confined too
    writeDenyDirs: [join(slugDir, "ground-truth")], // agent-readable, agent-unwritable
  };

  const sessions = join(repoRoot, ".neop", "sessions");
  mkdirSync(sessions, { recursive: true });
  const auditFile = join(sessions, `${task.id}-${runId}.audit.jsonl`);

  const deps: WorkerDeps = {
    models: opts.models,
    audit: new JsonlAuditSink(auditFile),
    admission: { admit: () => ({ ok: true }) },
    // dev mode (v3 §8): gates auto-approve — visibly, as "dev-mode" — so the
    // stubbed irreversible tool executes and logs what it WOULD have done.
    // Live mode: no approvals here; irreversible actions park (resume via plane).
    approvals: opts.dev
      ? {
          find: (actionKey) => ({ runId, actionKey, decision: "approve" as const, approvedBy: "dev-mode", ts: new Date().toISOString() }),
        }
      : { find: () => null },
    clock: () => Date.now(),
    successCheck: new ShellSuccessCheckRunner(120_000),
    makeTools: bound.makeTools,
  };

  const outcome = await runWorker(input, deps);
  if (drift.length && outcome.reason === undefined) {
    outcome.reason = `pin drift: ${drift.map(([n, v]) => `${n} ${v}→${resolved.pins[n]}`).join(", ")}`;
  }

  // failed trees stay put for post-mortem (v3 §4); clean trees go away
  if (outcome.status === "landed" && !opts.keepWorktree) {
    removeWorktree(repoRoot, worktree);
  }
  return { outcome, worktree, auditFile, devLog };
}

// ---------------------------------------------------------------- the Foreman

export interface ForemanOptions {
  repoRoot: string;
  /** pinned git ref the Foreman's DEFINITION loads from (self-hosting guard). */
  fromRef?: string;
  requirement: string;
  owner: string;
  models: ResolvedModels;
}

/**
 * Run the Foreman: definition from a pinned ref, actions on the main working tree,
 * writes confined to registry/ + neops/ + .neop/. Its verbs are runtime tools over
 * this module's own functions — the factory building with the same hands it ships.
 */
export async function runForeman(opts: ForemanOptions): Promise<ContractRunResult> {
  const repoRoot = resolve(opts.repoRoot);
  const ref = opts.fromRef ?? "HEAD";
  const pinned = loadRegistryFromRef(repoRoot, ref);
  // the Foreman ACTS on the working-tree registry (spawning validates against what
  // will actually run) — only its own definition is pinned.
  const working = loadRegistry(join(repoRoot, "registry"));
  const resolved: ResolvedTemplate = resolveTemplate(pinned, "foreman", { withOptional: ["reap_neop"] });

  const runtime: Record<string, RuntimeHandler> = {
    spawn_neop: (p) => {
      const specFile = String(p.spec ?? "");
      if (specFile) {
        // the Foreman wrote a spec file with write_spec; spawn from it
        const slug = specFile.match(/neops\/([a-z0-9-]+\/[a-z0-9-]+)\/spec\.md/)?.[1];
        if (!slug) return `refused: "${specFile}" is not neops/<client>/<slug>/spec.md`;
        const spec: Spec = loadSpec(repoRoot, slug);
        rmSync(specPath(repoRoot, slug)); // spawnNeop re-writes it with pins stamped
        const { pins } = spawnNeop(repoRoot, working, {
          slug,
          template: spec.template,
          owner: spec.owner,
          withOptional: spec.withOptional,
          charter: spec.body,
        });
        return `spawned ${slug} (pins: ${Object.entries(pins).map(([k, v]) => `${k}@${v}`).join(", ")})`;
      }
      return "refused: pass {spec: 'neops/<client>/<slug>/spec.md'}";
    },
    list_neops: () =>
      JSON.stringify(listFleet(repoRoot).map((e) => ({ slug: e.slug, template: e.template, owner: e.owner }))),
    reap_neop: (p) => {
      const slug = String(p.slug ?? "");
      const { removed } = reapNeop(repoRoot, slug);
      return removed.length ? `reaped: ${removed.join(", ")}` : `nothing running for ${slug}`;
    },
  };

  const bound = bindRegistryTools(resolved.tools, { runtime });

  const task: TaskContract = {
    id: "foreman",
    description: `You are the FOREMAN. Your task is to CREATE AND SPAWN a NEOP (write its spec.md, call spawn_neop) satisfying this requirement — not to perform the requirement yourself: ${opts.requirement}`,
    systemPrompt: resolved.systemPrompt,
    tools: resolved.tools.map((t) => ({ name: t.name, class: t.mappedClass })),
    successCheck: resolved.contracts[0]!.successCheck,
    scope: "foreman",
    ceilings: { maxTokens: resolved.resources.tokenBudget, wallClockMs: resolved.resources.wallClock * 1000 },
  };

  // the Foreman must NEVER stage the operator's working tree — snapshot from its
  // own performed actions instead of `git add -A` on the real repo.
  const snapshot = (_root: string, performed: ActionRequest[]): RunArtifacts => ({
    diff: performed.map((a) => `${a.tool} ${a.targetPath ?? JSON.stringify(a.args ?? {})}`).join("\n") || "(no actions)",
    filesChanged: performed.map((a) => a.targetPath).filter((p): p is string => !!p),
    successCheck: { exitCode: 0, stdout: "", stderr: "" },
    actions: performed,
  });

  const input: RunInput = {
    runId: `foreman-${Math.random().toString(36).slice(2, 8)}`,
    task,
    worktreeRoot: repoRoot,
    egressAllowlist: [],
    logicalDate: new Date().toISOString().slice(0, 10),
    readJail: true,
    writeAllowDirs: [join(repoRoot, "registry"), join(repoRoot, "neops"), join(repoRoot, ".neop")],
    writeDenyDirs: [join(repoRoot, "registry")], // Foreman READS the registry; humans edit it
  };

  // the Foreman's contract is "a spawn happened THIS run" — a marker left by a
  // previous build must not satisfy it (found live: stale marker green-lit a
  // run that spawned nothing; only the verifier caught it)
  rmSync(join(repoRoot, ".neop", "last-spawn"), { force: true });

  const sessions = join(repoRoot, ".neop", "sessions");
  mkdirSync(sessions, { recursive: true });
  const auditFile = join(sessions, `${input.runId}.audit.jsonl`);

  const outcome = await runWorker(input, {
    models: opts.models,
    audit: new JsonlAuditSink(auditFile),
    admission: { admit: () => ({ ok: true }) },
    approvals: { find: () => null },
    clock: () => Date.now(),
    successCheck: new ShellSuccessCheckRunner(60_000),
    makeTools: bound.makeTools,
    snapshot,
  });

  return { outcome, worktree: repoRoot, auditFile, devLog: [] };
}

// ---------------------------------------------------------------- promote (QB5)

/** Commit the spec (one NEOP, one commit) — the PR is the operator's next `gh pr create`. */
export function promoteNeop(repoRoot: string, slug: string): string {
  const p = specPath(repoRoot, slug);
  if (!existsSync(p)) throw new Error(`no spec for "${slug}"`);
  git(repoRoot, ["add", join("neops", slug)]);
  git(repoRoot, ["commit", "-m", `neop: promote ${slug}`]);
  return git(repoRoot, ["log", "-1", "--format=%h %s"]).trim();
}

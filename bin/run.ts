/**
 * Minimal CLI to execute ONE task contract through the real worker against a git
 * worktree — the live smoke test path (§ Phase 0 "10 consecutive manual runs").
 *
 * Usage:
 *   npm run dev:run -- <task.yaml> [--worktree <dir>] [--audit <file.jsonl>]
 *
 * Provider/model come from the environment (NEOP_PROVIDER / NEOP_WORK_MODEL /
 * NEOP_VERIFY_MODEL, defaults in src/pi/config.ts) and the provider's own key
 * (e.g. ANTHROPIC_API_KEY). With no key set this fails fast with a clear message —
 * building and testing never require one.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  JsonlAuditSink,
  ShellSuccessCheckRunner,
  buildModels,
  loadTaskFromYaml,
  modelConfigFromEnv,
  runWorker,
  TOOL_REGISTRY,
  type RunInput,
  type WorkerDeps,
} from "../src/index.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** Use the given worktree, or spin up a fresh throwaway git repo. */
function ensureWorktree(dir: string | undefined): string {
  if (dir) return resolve(dir);
  const d = mkdtempSync(join(tmpdir(), "neop-run-"));
  git(d, "init -q");
  git(d, 'config user.email "neop@local"');
  git(d, 'config user.name "neop"');
  git(d, "commit -q -m seed --allow-empty");
  return d;
}

async function main(): Promise<void> {
  const taskPath = process.argv[2];
  if (!taskPath || taskPath.startsWith("--")) {
    console.error("usage: npm run dev:run -- <task.yaml> [--worktree <dir>] [--audit <file.jsonl>]");
    process.exit(2);
  }

  const task = loadTaskFromYaml(readFileSync(resolve(taskPath), "utf8"), TOOL_REGISTRY);
  const worktreeRoot = ensureWorktree(arg("--worktree"));

  const cfg = modelConfigFromEnv();
  console.error(`[neop] provider=${cfg.provider} work=${cfg.work} verify=${cfg.verify} worktree=${worktreeRoot}`);
  const models = buildModels(cfg); // throws clearly on unknown model / missing provider

  // The audit trail must live OUTSIDE the worktree: the snapshot diffs the whole
  // tree, and the verifier (rightly) vetoes any file the task didn't ask for —
  // including our own bookkeeping. First live canary caught exactly this.
  const auditPath = arg("--audit") ?? `${worktreeRoot.replace(/\/$/, "")}.audit.jsonl`;
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, "", { flag: "a" });

  const deps: WorkerDeps = {
    models,
    audit: new JsonlAuditSink(auditPath),
    admission: { admit: () => ({ ok: true }) },
    approvals: { find: () => null },
    clock: () => Date.now(),
    successCheck: new ShellSuccessCheckRunner(),
  };

  const input: RunInput = {
    runId: `run-${task.id}`,
    task,
    worktreeRoot,
    egressAllowlist: [],
    logicalDate: new Date().toISOString().slice(0, 10),
    expectedPaths: task.scope ? [task.scope] : undefined,
  };

  const outcome = await runWorker(input, deps);
  console.log(JSON.stringify(outcome, null, 2));
  console.error(`[neop] audit trail: ${auditPath}`);
  process.exit(outcome.status === "landed" ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});

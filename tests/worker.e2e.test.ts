/**
 * END-TO-END: the worker on a REAL git worktree, REAL shell successCheck, REAL diff,
 * REAL tool execution and gate — driven by pi's faux provider (no network, no key).
 *
 * This is the proof the invariants hold when wired to the actual pi Agent loop:
 * the gate runs in beforeToolCall, ceilings abort, "done" comes from an independent
 * check, and the cold verifier vetoes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker, type WorkerDeps, type RunInput } from "../src/pi/worker.js";
import { ShellSuccessCheckRunner } from "../src/successCheck.js";
import { MemoryAuditSink } from "../src/audit.js";
import { makeRepo } from "./support/git.js";
import { fauxModels, fauxToolCall, toolTurn, stopTurn, verdictTurn } from "./support/faux.js";
import { task, fakeClock, ADMIT_ALL, ADMIT_NONE, approvalStore } from "./fixtures.js";
import type { ResolvedModels } from "../src/pi/provider.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function repo(seed: Record<string, string> = { "docs/api/index.md": "stale\n" }): string {
  const d = mkdtempSync(join(tmpdir(), "neop-e2e-"));
  dirs.push(d);
  makeRepo(d, seed);
  return d;
}

function deps(models: ResolvedModels, audit = new MemoryAuditSink(), over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    models,
    audit,
    admission: ADMIT_ALL,
    approvals: approvalStore(),
    clock: fakeClock(1000),
    successCheck: new ShellSuccessCheckRunner(10_000),
    ...over,
  };
}

function input(wt: string, over: Partial<RunInput> = {}): RunInput {
  return {
    runId: "e2e",
    task: task({
      successCheck: "grep -q GENERATED docs/api/index.md",
      tools: [{ name: "write_file", class: "workspace_write" }],
    }),
    worktreeRoot: wt,
    egressAllowlist: [],
    logicalDate: "2026-07-30",
    expectedPaths: ["docs"],
    allowTestChanges: false,
    ...over,
  };
}

const writeDoc = (content: string) => fauxToolCall("write_file", { path: "docs/api/index.md", content });

describe("worker E2E — real worktree, faux model", () => {
  it("HAPPY PATH: writes the doc, real check passes, verifier passes → landed", async () => {
    const wt = repo();
    const audit = new MemoryAuditSink();
    const models = fauxModels([toolTurn(writeDoc("GENERATED from source\n")), stopTurn()], [verdictTurn(true, ["ok"])]);
    const out = await runWorker(input(wt), deps(models, audit));

    expect(out.status).toBe("landed");
    expect(out.verdict?.pass).toBe(true);
    expect(readFileSync(join(wt, "docs/api/index.md"), "utf8")).toContain("GENERATED");
    const sc = audit.events.find((e) => e.type === "success_check");
    expect(sc && "exitCode" in sc && sc.exitCode).toBe(0);
  });

  it("INDEPENDENT successCheck: agent 'finishes' but the real check is RED → not landed", async () => {
    const wt = repo();
    // content lacks the required GENERATED marker; the agent's claim is irrelevant.
    const models = fauxModels([toolTurn(writeDoc("I promise this is done\n")), stopTurn()]);
    const out = await runWorker(input(wt), deps(models));
    expect(out.status).not.toBe("landed");
    expect(out.verdict?.pass).toBe(false);
    expect(out.verdict?.reasons.join(" ")).toMatch(/exited/);
  });

  it("GAMING: touching a test file out of scope → static veto → escalated", async () => {
    const wt = repo();
    const models = fauxModels([
      toolTurn(writeDoc("GENERATED from source\n"), fauxToolCall("write_file", { path: "tests/sneaky.test.ts", content: "// weakened\n" })),
      stopTurn(),
    ]);
    const out = await runWorker(input(wt), deps(models));
    expect(out.status).toBe("escalated");
    expect(out.verdict?.testsTampered).toBe(true);
  });

  it("STANDING DENIAL: a force-push is hard-denied; the legit work still lands", async () => {
    const wt = repo();
    const audit = new MemoryAuditSink();
    const t: Partial<RunInput> = {
      task: task({
        successCheck: "grep -q GENERATED docs/api/index.md",
        tools: [
          { name: "write_file", class: "workspace_write" },
          { name: "git", class: "workspace_write" },
        ],
      }),
    };
    const models = fauxModels([
      toolTurn(fauxToolCall("git", { command: "push --force origin main" }), writeDoc("GENERATED from source\n")),
      stopTurn(),
    ], [verdictTurn(true)]);
    const out = await runWorker(input(wt, t), deps(models, audit));
    const denied = audit.events.find((e) => e.type === "action" && "decision" in e && e.decision.verdict === "deny");
    expect(denied).toBeTruthy();
    expect(out.status).toBe("landed");
  });

  it("IRREVERSIBLE: a publish parks the run at awaiting_human", async () => {
    const wt = repo();
    const t: Partial<RunInput> = {
      task: task({ successCheck: "true", tools: [{ name: "publish_post", class: "public_publish" }] }),
    };
    const models = fauxModels([toolTurn(fauxToolCall("publish_post", { text: "hi" }))]);
    const out = await runWorker(input(wt, t), deps(models));
    expect(out.status).toBe("awaiting_human");
    expect(out.pendingAction?.tool).toBe("publish_post");
  });

  it("§6.2 SINGLE-USE: an approval is honoured exactly once — an identical action later is a duplicate", async () => {
    const t: Partial<RunInput> = {
      task: task({ successCheck: "true", tools: [{ name: "publish_post", class: "public_publish" }] }),
    };
    // one shared approval store across both runs, pre-approved for whatever key the
    // gate computes (the store consumes on use, like the control plane's)
    const store = (() => {
      const byKey = new Map<string, import("../src/types.js").Approval>();
      return {
        find: (k: string) => {
          if (!byKey.has(k)) {
            byKey.set(k, { runId: "r", actionKey: k, decision: "approve" as const, approvedBy: "op", ts: "2026-07-30T09:00:00Z" });
          }
          return byKey.get(k)!;
        },
        consume: (k: string, at: string) => {
          const a = byKey.get(k);
          if (a && !a.consumedAt) a.consumedAt = at;
        },
      };
    })();

    // first run: approval honoured, publish goes through, run lands
    const first = await runWorker(
      input(repo(), t),
      deps(fauxModels([toolTurn(fauxToolCall("publish_post", { text: "hi" })), stopTurn()]), new MemoryAuditSink(), { approvals: store }),
    );
    expect(first.status).toBe("landed");

    // second run, SAME logical date + identical args → same key, already consumed →
    // the publish is DENIED as a duplicate; the run itself still completes
    const audit2 = new MemoryAuditSink();
    const second = await runWorker(
      input(repo(), t),
      deps(fauxModels([toolTurn(fauxToolCall("publish_post", { text: "hi" })), stopTurn()]), audit2, { approvals: store }),
    );
    expect(second.status).toBe("landed"); // check is "true"; the run finishes
    const dup = audit2.events.find(
      (e) => e.type === "action" && e.decision.verdict === "deny" && /duplicate/.test(e.decision.reason),
    );
    expect(dup).toBeTruthy(); // the duplicate publish itself never executed
  });

  it("§2.3 CEILING: the action ceiling aborts before the write and lands flagged", async () => {
    const wt = repo();
    const audit = new MemoryAuditSink();
    const t: Partial<RunInput> = {
      task: task({
        successCheck: "true",
        tools: [{ name: "write_file", class: "workspace_write" }],
        ceilings: { maxActions: 0 },
      }),
    };
    const models = fauxModels([toolTurn(writeDoc("GENERATED\n")), stopTurn()], [verdictTurn(true)]);
    const out = await runWorker(input(wt, t), deps(models, audit));
    expect(audit.events.some((e) => e.type === "ceiling_breach")).toBe(true);
    expect(out.reason).toMatch(/ceiling/);
    // the write never happened — the ceiling fired before spend
    expect(readFileSync(join(wt, "docs/api/index.md"), "utf8")).not.toContain("GENERATED");
  });

  it("drops a run that admission control rejects", async () => {
    const wt = repo();
    const models = fauxModels([]);
    const out = await runWorker(input(wt), deps(models, new MemoryAuditSink(), { admission: ADMIT_NONE }));
    expect(out.status).toBe("dropped");
    expect(out.reason).toMatch(/breaker/i);
  });
});

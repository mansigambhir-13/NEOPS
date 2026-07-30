/**
 * END-TO-END integration: real git worktree, real shell successCheck, real diff.
 * No mocks below the AgentRuntime boundary except the (stubbed) cold verifier model.
 * This is the proof the pieces actually compose on a real machine.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLifecycle, type LifecycleDeps, type RunInput } from "../src/lifecycle.js";
import { ShellSuccessCheckRunner } from "../src/successCheck.js";
import { MemoryAuditSink } from "../src/audit.js";
import { RealRuntime, makeRepo, type RealRunPlan } from "./support/realRuntime.js";
import { task, fakeClock, ADMIT_ALL, approvalStore } from "./fixtures.js";

const PASS = '{"pass": true, "reasons": ["diff regenerates the doc"]}';
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "neop-e2e-"));
  dirs.push(d);
  // seed a stale doc + a real check script marker
  makeRepo(d, { "docs/api/index.md": "stale\n" });
  return d;
}

function deps(runtime: RealRuntime, audit = new MemoryAuditSink()): LifecycleDeps {
  return {
    runtime,
    audit,
    admission: ADMIT_ALL,
    approvals: approvalStore(),
    clock: fakeClock(1000),
    successCheckRunner: new ShellSuccessCheckRunner(10_000),
  };
}

function input(wt: string, over: Partial<RunInput> = {}): RunInput {
  return {
    runId: "e2e",
    task: task({ successCheck: "grep -q GENERATED docs/api/index.md" }),
    worktreeRoot: wt,
    egressAllowlist: [],
    logicalDate: "2026-07-30",
    models: { work: "big", verify: "small" },
    expectedPaths: ["docs"],
    allowTestChanges: false,
    ...over,
  };
}

describe("E2E — real worktree / real successCheck / real diff", () => {
  it("HAPPY PATH: regenerates the doc on disk, check passes, verifier passes → landed", async () => {
    const wt = repo();
    const plan: RealRunPlan = {
      edits: [{ path: "docs/api/index.md", content: "GENERATED from source\n" }],
      verification: PASS,
    };
    const audit = new MemoryAuditSink();
    const out = await runLifecycle(input(wt), deps(new RealRuntime(plan), audit));

    expect(out.status).toBe("landed");
    // the file really changed on disk
    expect(existsSync(join(wt, "docs/api/index.md"))).toBe(true);
    expect(readFileSync(join(wt, "docs/api/index.md"), "utf8")).toContain("GENERATED");
    // the successCheck really ran and was audited green
    const sc = audit.events.find((e) => e.type === "success_check");
    expect(sc && "exitCode" in sc && sc.exitCode).toBe(0);
  });

  it("INDEPENDENT successCheck: agent 'finishes' but the real check is RED → not landed", async () => {
    const wt = repo();
    // agent writes content WITHOUT the required marker; its own artifact claims done,
    // but the lifecycle runs the real grep, which fails.
    const plan: RealRunPlan = {
      edits: [{ path: "docs/api/index.md", content: "I promise this is done\n" }],
      verification: PASS,
    };
    const out = await runLifecycle(input(wt), deps(new RealRuntime(plan)));
    expect(out.status).not.toBe("landed");
    expect(out.verdict?.pass).toBe(false);
    expect(out.verdict?.reasons.join(" ")).toMatch(/exited/);
  });

  it("GAMING: agent touches a test file out of scope → static veto → escalated", async () => {
    const wt = repo();
    const plan: RealRunPlan = {
      edits: [
        { path: "docs/api/index.md", content: "GENERATED from source\n" },
        { path: "tests/sneaky.test.ts", content: "// weakened\n" },
      ],
      verification: PASS,
    };
    const out = await runLifecycle(input(wt), deps(new RealRuntime(plan)));
    expect(out.status).toBe("escalated");
    expect(out.verdict?.testsTampered).toBe(true);
  });

  it("STANDING DENIAL: a force-push probe is hard-denied and the write never happens", async () => {
    const wt = repo();
    const audit = new MemoryAuditSink();
    const plan: RealRunPlan = {
      edits: [{ path: "docs/api/index.md", content: "GENERATED from source\n" }],
      extraActions: [{ tool: "git", args: { cmd: "push --force origin main" } }],
      verification: PASS,
    };
    // bind a git tool so the action has a class to resolve
    const t = task({
      successCheck: "grep -q GENERATED docs/api/index.md",
      tools: [
        { name: "edit_file", class: "workspace_write" },
        { name: "git", class: "workspace_write" },
      ],
    });
    const out = await runLifecycle(input(wt, { task: t }), deps(new RealRuntime(plan), audit));
    const denied = audit.events.find((e) => e.type === "action" && "decision" in e && e.decision.verdict === "deny");
    expect(denied).toBeTruthy();
    // the run still completes its legit work
    expect(out.status).toBe("landed");
  });

  it("IRREVERSIBLE: a publish probe parks the run at awaiting_human", async () => {
    const wt = repo();
    const plan: RealRunPlan = {
      edits: [],
      extraActions: [{ tool: "publish_post", args: { text: "hi" } }],
      verification: PASS,
    };
    const t = task({
      successCheck: "true",
      tools: [{ name: "publish_post", class: "public_publish" }],
    });
    const out = await runLifecycle(input(wt, { task: t }), deps(new RealRuntime(plan)));
    expect(out.status).toBe("awaiting_human");
    expect(out.pendingAction?.tool).toBe("publish_post");
  });
});

import { describe, it, expect } from "vitest";
import { runLifecycle } from "../src/lifecycle.js";
import type { LifecycleDeps, RunInput } from "../src/lifecycle.js";
import { FakeRuntime } from "../src/runtime/fakeRuntime.js";
import { MemoryAuditSink } from "../src/audit.js";
import type { Approval } from "../src/types.js";
import { task, artifacts, action, fakeClock, ADMIT_ALL, ADMIT_NONE, approvalStore } from "./fixtures.js";

const PASS = '{"pass": true, "reasons": ["ok"]}';
const VETO = '{"pass": false, "reasons": ["scope creep"]}';

function input(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: "run-1",
    task: task(),
    worktreeRoot: "/runs/run-1/wt",
    egressAllowlist: [],
    logicalDate: "2026-07-30",
    models: { work: "big", verify: "small" },
    expectedPaths: ["docs"],
    allowTestChanges: false,
    ...over,
  };
}

function deps(runtime: FakeRuntime, over: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    runtime,
    audit: new MemoryAuditSink(),
    admission: ADMIT_ALL,
    approvals: approvalStore(),
    clock: fakeClock(1000),
    ...over,
  };
}

describe("§5 run lifecycle", () => {
  it("lands a reversible run that passes verification", async () => {
    const rt = new FakeRuntime(
      { actions: [action({ tool: "edit_file", targetPath: "/runs/run-1/wt/docs/api/index.md" })], artifacts: artifacts() },
      { text: PASS },
    );
    const out = await runLifecycle(input(), deps(rt));
    expect(out.status).toBe("landed");
    expect(out.verdict?.pass).toBe(true);
  });

  it("parks at awaiting_human on an irreversible action with no approval", async () => {
    const rt = new FakeRuntime(
      { actions: [action({ tool: "publish_post" })], artifacts: artifacts() },
      { text: PASS },
    );
    const t = task({ tools: [{ name: "publish_post", class: "public_publish" }] });
    const out = await runLifecycle(input({ task: t }), deps(rt));
    expect(out.status).toBe("awaiting_human");
    expect(out.pendingAction?.tool).toBe("publish_post");
  });

  it("proceeds when a human approval already exists (idempotent honour)", async () => {
    const rt = new FakeRuntime(
      { actions: [action({ tool: "publish_post" })], artifacts: artifacts() },
      { text: PASS },
    );
    const t = task({ tools: [{ name: "publish_post", class: "public_publish" }] });
    // Permissive store: an approval exists for whatever key the gate computes.
    const approval: Approval = {
      runId: "run-1",
      actionKey: "*",
      decision: "approve",
      approvedBy: "ml",
      ts: "2026-07-30T09:30:00Z",
    };
    const store = { find: () => approval };
    const out = await runLifecycle(input({ task: t }), deps(rt, { approvals: store }));
    expect(out.status).toBe("landed");
  });

  it("escalates (no auto-retry) on a verifier veto", async () => {
    const rt = new FakeRuntime(
      { actions: [action({ tool: "edit_file", targetPath: "/runs/run-1/wt/docs/api/index.md" })], artifacts: artifacts() },
      { text: VETO },
    );
    const out = await runLifecycle(input(), deps(rt));
    expect(out.status).toBe("escalated");
    expect(out.verdict?.pass).toBe(false);
  });

  it("drops a run that admission control rejects", async () => {
    const rt = new FakeRuntime({ actions: [], artifacts: artifacts() }, { text: PASS });
    const out = await runLifecycle(input(), deps(rt, { admission: ADMIT_NONE }));
    expect(out.status).toBe("dropped");
    expect(out.reason).toMatch(/breaker/i);
  });

  it("audits a verifier veto as quarantined", async () => {
    const audit = new MemoryAuditSink();
    const rt = new FakeRuntime(
      { actions: [action({ tool: "edit_file", targetPath: "/runs/run-1/wt/docs/api/index.md" })], artifacts: artifacts() },
      { text: VETO },
    );
    await runLifecycle(input(), deps(rt, { audit }));
    expect(audit.events.some((e) => e.type === "quarantined")).toBe(true);
    expect(audit.events.some((e) => e.type === "verdict")).toBe(true);
  });

  it("§2.3 denies actions once the action ceiling is hit and lands flagged", async () => {
    const rt = new FakeRuntime(
      { actions: [action({ tool: "edit_file", targetPath: "/runs/run-1/wt/docs/api/index.md" })], artifacts: artifacts() },
      { text: PASS },
    );
    const t = task({ ceilings: { maxActions: 0 } });
    const audit = new MemoryAuditSink();
    const out = await runLifecycle(input({ task: t }), deps(rt, { audit }));
    expect(audit.events.some((e) => e.type === "ceiling_breach")).toBe(true);
    expect(out.reason).toMatch(/ceiling/);
  });
});

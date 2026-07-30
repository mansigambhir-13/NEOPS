import { describe, it, expect } from "vitest";
import {
  statusToVerdict,
  toConsoleRun,
  toConsoleGate,
  humanDuration,
  humanTokens,
  actionChips,
} from "../src/api/adapter.js";

describe("statusToVerdict — worker RunStatus → console verdict", () => {
  it("maps landed → verified", () => {
    expect(statusToVerdict({ status: "landed" })).toBe("verified");
  });
  it("maps escalated → vetoed", () => {
    expect(statusToVerdict({ status: "escalated" })).toBe("vetoed");
  });
  it("maps awaiting_human → awaiting", () => {
    expect(statusToVerdict({ status: "awaiting_human" })).toBe("awaiting");
  });
  it("maps quarantined → failed", () => {
    expect(statusToVerdict({ status: "quarantined" })).toBe("failed");
  });
  it("maps running/admitted/verifying → running", () => {
    for (const s of ["running", "admitted", "verifying"]) {
      expect(statusToVerdict({ status: s })).toBe("running");
    }
  });
  it("unknown/dropped → failed (fail visible, never silently 'verified')", () => {
    expect(statusToVerdict({ status: "dropped" })).toBe("failed");
    expect(statusToVerdict({ status: "??" })).toBe("failed");
  });
});

describe("toConsoleRun — control-plane record → view model", () => {
  it("derives verdict from status when not provided", () => {
    const r = toConsoleRun({ runId: "x1", taskId: "doc-sync", status: "landed", reasons: ["ok"] });
    expect(r.id).toBe("x1");
    expect(r.task).toBe("doc-sync");
    expect(r.verdict).toBe("verified");
    expect(r.note).toBe("ok");
  });
  it("passes through an explicit console-shaped run untouched", () => {
    const r = toConsoleRun({ id: "7b09", task: "content-draft", verdict: "awaiting", gate: { cls: "publish_public", ask: "Publish?", opts: ["Yes", "No"] } });
    expect(r.verdict).toBe("awaiting");
    expect(r.gate.cls).toBe("publish_public");
    expect(r.gate.ask).toBe("Publish?"); // rich gates pass through untouched
  });

  it("maps a real control-plane wire record end to end", () => {
    // captured from GET /runs on the live demo plane (RECONCILIATION.md §2 fixture)
    const wire = {
      runId: "e212df94",
      taskId: "content-draft",
      status: "awaiting_human",
      startedAt: "2026-07-30T08:57:37.022Z",
      durationMs: 3,
      tokens: 1302,
      note: "irreversible action requires approval",
      successCheck: "test -s content/draft.md",
      actionCounts: { edit_file: 1 },
      gate: { cls: "public_publish", tool: "publish_post", actionKey: "content-draft:2026-07-30:f3c8d028" },
    };
    const r = toConsoleRun(wire);
    expect(r.id).toBe("e212df94");
    expect(r.task).toBe("content-draft");
    expect(r.verdict).toBe("awaiting");
    expect(r.dur).toBe("3ms");
    expect(r.tok).toBe("1.3k");
    expect(r.check).toBe("test -s content/draft.md");
    expect(r.actions).toEqual(["edit_file"]);
    // class-only gate is synthesised into a human question + options
    expect(r.gate.ask).toMatch(/publish/i);
    expect(r.gate.opts.length).toBeGreaterThanOrEqual(2);
  });

  it("declined verdict override survives the mapping", () => {
    const r = toConsoleRun({ runId: "x", taskId: "t", status: "dropped", verdict: "declined", tokens: 0 });
    expect(r.verdict).toBe("declined");
  });
});

describe("humanisers + gate synthesis", () => {
  it("humanDuration", () => {
    expect(humanDuration(412)).toBe("412ms");
    expect(humanDuration(5000)).toBe("5s");
    expect(humanDuration(372_000)).toBe("6m 12s");
    expect(humanDuration(undefined)).toBe("—");
  });
  it("humanTokens", () => {
    expect(humanTokens(84_200)).toBe("84.2k");
    expect(humanTokens(1_302)).toBe("1.3k");
    expect(humanTokens(1_200_000)).toBe("1.2M");
    expect(humanTokens(42)).toBe("42");
  });
  it("actionChips aggregates counts", () => {
    expect(actionChips({ read_file: 14, open_pr: 1 })).toEqual(["read_file ×14", "open_pr"]);
    expect(actionChips(undefined)).toEqual([]);
  });
  it("every irreversible class has a gate prompt with a deny-inferable option", () => {
    for (const cls of ["public_publish", "external_email", "spend", "prod_write", "pr_merge", "unknown"]) {
      const g = toConsoleGate({ cls });
      expect(g.ask.length).toBeGreaterThan(0);
      // at least one option must read as a deny to decisionFromOption
      expect(g.opts.some((o) => /don'?t|hold|no\b|cancel|skip/i.test(o))).toBe(true);
    }
  });
});

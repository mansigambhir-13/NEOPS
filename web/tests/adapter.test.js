import { describe, it, expect } from "vitest";
import { statusToVerdict, toConsoleRun } from "../src/api/adapter.js";

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
    const r = toConsoleRun({ id: "7b09", task: "content-draft", verdict: "awaiting", gate: { cls: "publish_public" } });
    expect(r.verdict).toBe("awaiting");
    expect(r.gate.cls).toBe("publish_public");
  });
});

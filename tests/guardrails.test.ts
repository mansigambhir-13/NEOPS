/**
 * §10 cost guardrails + §6.4 circuit breaker + live task-file loading — the three
 * things that make unattended operation survivable. All through the real plane
 * (demo faux models, real worktrees, real checks).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/server/controlPlane.js";
import { fauxModels } from "../src/server/demo.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

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
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("§10 daily token cap — checked before spend", () => {
  it("refuses new runs once today's tokens cross the cap", async () => {
    const p = new ControlPlane({ port: 0, mode: "demo", dailyTokenCap: 1 });
    await p.execute("doc-sync"); // first run admitted at 0 spent, lands, records usage
    expect(p.tokensToday()).toBeGreaterThan(0);
    await expect(p.execute("doc-sync")).rejects.toThrow(/daily token cap/);
  });

  it("the cap also stops resumes (spend is spend)", async () => {
    const p = new ControlPlane({ port: 0, mode: "demo", dailyTokenCap: 1 });
    const parked = await p.execute("content-draft"); // parks (usage recorded)
    await expect(p.decideGate(parked.runId, "public_publish", "approve", "x")).rejects.toThrow(/daily token cap/);
  });

  it("metrics reports the real cap and spend", async () => {
    const p = new ControlPlane({ port: 0, mode: "demo", dailyTokenCap: 500_000 });
    await p.execute("doc-sync");
    const m = p.metrics();
    expect(m.spend.cap).toBe("500.0k");
    expect(m.spend.used).not.toBe("0");
  });
});

describe("§6.4 circuit breaker — two consecutive failures trip it", () => {
  it("trips after two vetoes, blocks the third run, reset re-arms, and it's journaled", async () => {
    const dir = tmp("neop-brk-");
    const p = new ControlPlane({ port: 0, mode: "demo", dataDir: dir });

    // alert-triage's demo scenario always ends in a verifier veto (escalated)
    await p.execute("alert-triage");
    expect(p.breakerState("alert-triage")).toEqual({ open: false, consecutiveFailures: 1 });
    await p.execute("alert-triage");
    expect(p.breakerState("alert-triage").open).toBe(true);
    expect(p.metrics().breakers).toContain("alert-triage");

    await expect(p.execute("alert-triage")).rejects.toThrow(/breaker OPEN/);

    p.resetBreaker("alert-triage");
    expect(p.breakerState("alert-triage").open).toBe(false);
    await p.execute("alert-triage"); // admitted again (and fails again — that's day 2's problem)

    // the reset survives a restart: one post-reset failure ≠ tripped
    const q = new ControlPlane({ port: 0, mode: "demo", dataDir: dir });
    q.restore();
    expect(q.breakerState("alert-triage")).toEqual({ open: false, consecutiveFailures: 1 });
  });

  it("a success ends the failure streak; a human decline is not a task failure", async () => {
    const p = new ControlPlane({ port: 0, mode: "demo" });
    await p.execute("alert-triage"); // fail (1)
    await p.execute("doc-sync"); // different task — irrelevant to alert-triage's streak
    expect(p.breakerState("alert-triage").consecutiveFailures).toBe(1);
    expect(p.breakerState("doc-sync").consecutiveFailures).toBe(0);

    const parked = await p.execute("content-draft");
    await p.decideGate(parked.runId, "public_publish", "deny", "not today");
    expect(p.breakerState("content-draft").consecutiveFailures).toBe(0); // declined ≠ failed
  });
});

describe("live task-file loading (tasks/*.yaml through the plane)", () => {
  it("loads a contract file, lists it, and runs it end to end in live mode", async () => {
    const tasksDir = tmp("neop-tasks-");
    writeFileSync(
      join(tasksDir, "hello.yaml"),
      [
        "id: hello-task",
        "description: say done and stop",
        "systemPrompt: you are neop",
        'successCheck: "true"',
        "scope: docs",
        "tools:",
        "  - name: read_file",
      ].join("\n"),
    );
    const p = new ControlPlane({
      port: 0,
      mode: "live",
      tasksDir,
      // "live" models for the test are faux — the loading path is what's under test
      buildLiveModels: () => fauxModels([fauxAssistantMessage("done", { stopReason: "stop" })]),
    });

    const listed = p.listTasks();
    expect(listed.some((t) => t.taskId === "hello-task" && t.source === "file")).toBe(true);

    const rec = await p.execute("hello-task");
    expect(rec.outcome?.status).toBe("landed");
    expect(rec.task.scope).toBe("docs");
  });

  it("a malformed task file is skipped, not fatal; unknown tasks 404 with the known list", async () => {
    const tasksDir = tmp("neop-tasks-");
    writeFileSync(join(tasksDir, "broken.yaml"), "id: broken\n# no successCheck — must be refused by the loader");
    const p = new ControlPlane({ port: 0, mode: "live", tasksDir, buildLiveModels: () => fauxModels([]) });
    expect(p.listTasks().some((t) => t.taskId === "broken")).toBe(false);
    await expect(p.execute("nope")).rejects.toThrow(/unknown task/);
  });
});

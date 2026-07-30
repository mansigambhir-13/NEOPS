/**
 * §6.3 retry policy + the scheduler — the machinery that makes 3am survivable.
 * The retry rules are the plan's exact words; the tests are their contract.
 */

import { describe, it, expect } from "vitest";
import { parseCron, cronMatches } from "../src/scheduler/cron.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { classifyForRetry, runWithRetry } from "../src/server/retry.js";
import type { RunOutcome } from "../src/pi/worker.js";

// ---------------------------------------------------------------- cron matcher

describe("cron matcher (5-field, zero deps)", () => {
  const at = (min: number, hour: number, date: number, month: number, dowRef?: Date) =>
    dowRef ?? new Date(2026, month - 1, date, hour, min);

  it("matches the plan's own schedules", () => {
    // marketing weekly-queue: Mondays 10:00 — 2026-08-03 is a Monday
    const weekly = parseCron("0 10 * * 1");
    expect(cronMatches(weekly, new Date(2026, 7, 3, 10, 0))).toBe(true);
    expect(cronMatches(weekly, new Date(2026, 7, 4, 10, 0))).toBe(false); // Tuesday
    expect(cronMatches(weekly, new Date(2026, 7, 3, 10, 1))).toBe(false);

    // ops morning summary: 08:30 weekdays
    const morning = parseCron("30 8 * * 1-5");
    expect(cronMatches(morning, new Date(2026, 7, 5, 8, 30))).toBe(true); // Wed
    expect(cronMatches(morning, new Date(2026, 7, 8, 8, 30))).toBe(false); // Saturday
  });

  it("steps, lists, ranges", () => {
    const q = parseCron("*/15 9-17 * * *");
    expect(cronMatches(q, at(0, 9, 1, 6))).toBe(true);
    expect(cronMatches(q, at(45, 17, 1, 6))).toBe(true);
    expect(cronMatches(q, at(15, 8, 1, 6))).toBe(false);
    const l = parseCron("5,35 * 1,15 * *");
    expect(cronMatches(l, at(35, 3, 15, 2))).toBe(true);
    expect(cronMatches(l, at(35, 3, 14, 2))).toBe(false);
  });

  it("vixie dom/dow OR-rule when both are restricted", () => {
    const spec = parseCron("0 0 13 * 5"); // 13th OR Friday
    expect(cronMatches(spec, new Date(2026, 7, 13, 0, 0))).toBe(true); // the 13th (Thursday)
    expect(cronMatches(spec, new Date(2026, 7, 14, 0, 0))).toBe(true); // a Friday
    expect(cronMatches(spec, new Date(2026, 7, 12, 0, 0))).toBe(false);
  });

  it("refuses malformed expressions loudly", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("99 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("a * * * *")).toThrow(/bad cron/);
  });
});

// ---------------------------------------------------------------- scheduler

describe("scheduler", () => {
  it("fires at most once per matching minute; refusals are logged, never fatal", async () => {
    let now = new Date(2026, 7, 3, 10, 0, 5);
    const fired: string[] = [];
    const logs: string[] = [];
    const sched = new Scheduler(
      [
        { id: "weekly", cron: "0 10 * * 1", fire: async () => void fired.push("weekly") },
        { id: "tripped", cron: "0 10 * * 1", fire: async () => { throw new Error("circuit breaker OPEN"); } },
      ],
      () => now,
      (m) => void logs.push(m),
    );
    await sched.tick();
    await sched.tick(); // same minute — no refire
    expect(fired).toEqual(["weekly"]);
    expect(logs.some((l) => l.includes("tripped") && l.includes("breaker OPEN"))).toBe(true);

    now = new Date(2026, 7, 10, 10, 0, 5); // next Monday
    await sched.tick();
    expect(fired).toEqual(["weekly", "weekly"]);
  });

  it("a bad cron string is a reported problem, not a crash", () => {
    const sched = new Scheduler([{ id: "broken", cron: "not a cron", fire: async () => {} }]);
    expect(sched.jobCount).toBe(0);
    expect(sched.problems[0]).toMatch(/broken/);
  });
});

// ---------------------------------------------------------------- §6.3 retry

const landed: RunOutcome = { runId: "r", status: "landed" };
const transient: RunOutcome = { runId: "r", status: "quarantined", reason: "fetch failed: ECONNRESET" };
const checkFail: RunOutcome = {
  runId: "r",
  status: "escalated",
  reason: "verifier veto",
  verdict: { pass: false, reasons: ["successCheck exited 1 — run did not meet its own done bar"], outOfScope: false, testsTampered: false, secretsSuspected: false },
  checkOutput: { exitCode: 1, stdout: "", stderr: "grep: docs/api/index.md: No such file" },
};
const modelVeto: RunOutcome = {
  runId: "r",
  status: "escalated",
  reason: "verifier veto",
  verdict: { pass: false, reasons: ["the diff does not accomplish the task"], outOfScope: false, testsTampered: false, secretsSuspected: false },
};

describe("§6.3 classification", () => {
  it("network/5xx/rate-limit quarantines are transient; others are not", () => {
    expect(classifyForRetry(transient)).toBe("transient");
    expect(classifyForRetry({ runId: "r", status: "quarantined", reason: "rate limit exceeded (429)" })).toBe("transient");
    expect(classifyForRetry({ runId: "r", status: "quarantined", reason: "interrupted by control-plane restart" })).toBe("none");
  });
  it("check-failure is a task failure; a model veto is NOT retryable", () => {
    expect(classifyForRetry(checkFail)).toBe("task_failure");
    expect(classifyForRetry(modelVeto)).toBe("none");
  });
  it("landed / awaiting / dropped never retry", () => {
    expect(classifyForRetry(landed)).toBe("none");
    expect(classifyForRetry({ runId: "r", status: "awaiting_human" })).toBe("none");
    expect(classifyForRetry({ runId: "r", status: "dropped", reason: "cap" })).toBe("none");
  });
});

describe("§6.3 loop", () => {
  const fast = { baseDelayMs: 1, sleep: async () => {} };

  it("transient: retries same context up to 3 attempts, with backoff calls", async () => {
    const outcomes = [transient, transient, landed];
    let i = 0;
    const retries: string[] = [];
    const r = await runWithRetry(async () => outcomes[i++]!, { ...fast, onRetry: (k) => void retries.push(k) });
    expect(r.attempts).toBe(3);
    expect(r.outcome.status).toBe("landed");
    expect(retries).toEqual(["transient", "transient"]);
  });

  it("transient: gives up after 3 attempts and returns the failure honestly", async () => {
    const r = await runWithRetry(async () => transient, fast);
    expect(r.attempts).toBe(3);
    expect(r.outcome.status).toBe("quarantined");
  });

  it("task failure: retried ONCE, with the check output injected — a different context", async () => {
    const seenMods: (string | undefined)[] = [];
    const outcomes = [checkFail, landed];
    let i = 0;
    const r = await runWithRetry(async (mods) => {
      seenMods.push(mods.injectedFailure);
      return outcomes[i++]!;
    }, fast);
    expect(r.attempts).toBe(2);
    expect(seenMods[0]).toBeUndefined();
    expect(seenMods[1]).toContain("No such file"); // the failure rode into the retry
    expect(seenMods[1]).toContain("Diagnose");
  });

  it("task failure twice: the second failure stands — one retry means one", async () => {
    const r = await runWithRetry(async () => checkFail, fast);
    expect(r.attempts).toBe(2);
    expect(r.outcome.status).toBe("escalated");
  });

  it("verifier veto: exactly one attempt, no retry — a human should look", async () => {
    let calls = 0;
    const r = await runWithRetry(async () => {
      calls += 1;
      return modelVeto;
    }, fast);
    expect(calls).toBe(1);
    expect(r.outcome.status).toBe("escalated");
  });
});

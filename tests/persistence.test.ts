/**
 * Restart survival (§6.2 + §5): approvals — including their CONSUMED state —,
 * parked runs, and the ledger must all come back after the control plane process
 * dies. Simulated by building a second ControlPlane over the same dataDir and
 * calling restore(), which is exactly what bin/serve does on boot.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/server/controlPlane.js";

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

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "neop-data-"));
  dirs.push(d);
  return d;
}

function plane(dir: string): ControlPlane {
  return new ControlPlane({ port: 0, mode: "demo", dataDir: dir });
}

describe("journal persistence — restarts lose nothing", () => {
  it("a parked run survives restart and can STILL be approved → resumes → lands", async () => {
    const dir = dataDir();

    const a = plane(dir);
    const parked = await a.execute("content-draft");
    expect(parked.outcome?.status).toBe("awaiting_human");
    const runId = parked.runId;

    // "restart": a fresh plane over the same dataDir
    const b = plane(dir);
    const restored = b.restore();
    expect(restored?.resumable).toBe(1);

    const rec = b.ledger.get(runId);
    expect(rec).toBeTruthy();
    const wire = b.toWire(rec!);
    expect(wire.status).toBe("awaiting_human");
    expect(wire.gate).toBeTruthy(); // the gate is live again after restart

    const out = await b.decideGate(runId, "public_publish", "approve", "after restart");
    expect(out.run.outcome?.status).toBe("landed");
  });

  it("approvals AND their consumption survive — no duplicate after restart (§6.2)", async () => {
    const dir = dataDir();

    const a = plane(dir);
    const parked = await a.execute("content-draft");
    await a.decideGate(parked.runId, "public_publish", "approve", "ship");
    const key = a.approvals.find(
      a.ledger.get(parked.runId)!.decision!.actionKey,
    )!;
    expect(key.consumedAt).toBeTruthy(); // consumed when the gate honoured it

    const b = plane(dir);
    b.restore();
    const after = b.approvals.find(key.actionKey);
    expect(after?.decision).toBe("approve");
    // the critical §6.2 property: consumption survived, so a repeat of this exact
    // action would be hard-denied as a duplicate, not silently re-approved
    expect(after?.consumedAt).toBe(key.consumedAt);
  });

  it("a denied gate survives restart as declined", async () => {
    const dir = dataDir();
    const a = plane(dir);
    const parked = await a.execute("content-draft");
    await a.decideGate(parked.runId, "public_publish", "deny", "not this one");

    const b = plane(dir);
    b.restore();
    const wire = b.toWire(b.ledger.get(parked.runId)!);
    expect(wire.verdict).toBe("declined");
  });

  it("a run interrupted mid-flight is marked quarantined on restore, never 'running'", () => {
    const dir = dataDir();
    // simulate a crash after run_open was journaled but before any close
    mkdirSync(dir, { recursive: true });
    const record = {
      runId: "dead1234",
      task: { id: "doc-sync", description: "x", systemPrompt: "x", tools: [], successCheck: "true", scope: "docs" },
      startedAt: new Date().toISOString(),
      actionCounts: {},
      events: [],
    };
    writeFileSync(join(dir, "journal.jsonl"), JSON.stringify({ t: "run", record }) + "\n");

    const b = plane(dir);
    b.restore();
    const rec = b.ledger.get("dead1234")!;
    expect(rec.outcome?.status).toBe("quarantined");
    expect(rec.outcome?.reason).toMatch(/interrupted/);
  });

  it("a torn (crash-truncated) journal line is skipped, not fatal", async () => {
    const dir = dataDir();
    const a = plane(dir);
    await a.execute("doc-sync");
    appendFileSync(join(dir, "journal.jsonl"), '{"t":"run","record":{"runId":"tor'); // torn write

    const b = plane(dir);
    const restored = b.restore();
    expect(restored?.runs).toBe(1); // the good record; the torn one ignored
  });

  it("chats survive restart", async () => {
    const dir = dataDir();
    const a = plane(dir);
    a.answer("c1", "hello ledger");
    const b = plane(dir);
    b.restore();
    expect(b.thread("c1").length).toBe(2); // human + reply
  });
});

describe("bearer-token auth (prerequisite for any non-localhost deploy)", () => {
  it("rejects API calls without the token, accepts with, leaves /health open", async () => {
    const port = 8127;
    const p = new ControlPlane({ port, mode: "demo", adminToken: "s3cret" });
    const server = p.serve();
    await new Promise((r) => setTimeout(r, 100));
    try {
      const noAuth = await fetch(`http://localhost:${port}/runs`);
      expect(noAuth.status).toBe(401);
      const wrong = await fetch(`http://localhost:${port}/runs`, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      const ok = await fetch(`http://localhost:${port}/runs`, { headers: { authorization: "Bearer s3cret" } });
      expect(ok.status).toBe(200);
      const health = await fetch(`http://localhost:${port}/health`);
      expect(health.status).toBe(200); // liveness stays unauthenticated
    } finally {
      server.close();
    }
  });
});

/**
 * Whole-system benchmark: the FULL path the console exercises —
 *   HTTP POST /runs → control plane → pi Agent loop → worktree → git → shell
 *   check → cold verifier → ledger → HTTP response
 * plus the operator actions (GET bootstrap set, gate approve incl. resume).
 *
 * Demo mode (faux models) so the LLM layer is ~0 and the number measures the
 * SYSTEM: every subprocess, every HTTP hop, every ledger fold. Live-mode numbers
 * (LLM-dominated) live in PERFORMANCE.md §5 from the canary.
 *
 * Run: npm run build && node dist/bench/fullstack.js
 */

import { performance } from "node:perf_hooks";
import { ControlPlane } from "../src/server/controlPlane.js";

const PORT = 8124;
const BASE = `http://localhost:${PORT}`;

function fmt(n: number, unit = "") {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 }) + unit;
}
function line(label: string, value: string) {
  console.log("  " + label.padEnd(46) + value);
}
function header(t: string) {
  console.log("\n" + t + "\n" + "-".repeat(t.length));
}
function pcts(samples: number[]): { p50: number; p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * 0.5)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log("==================================================");
  console.log(" NEOP whole-system benchmark (HTTP → plane → worker)");
  console.log("==================================================");
  console.log(` node ${process.version}`);

  const plane = new ControlPlane({ port: PORT, mode: "demo" });
  const server = plane.serve();
  await new Promise((r) => setTimeout(r, 150));

  // ---------------------------------------------------- 1. single-run round trip
  header("1. POST /runs end-to-end (task → verdict over HTTP)");
  {
    const t: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await post("/runs", { taskId: "doc-sync" });
      t.push(performance.now() - t0);
    }
    const { p50, p95 } = pcts(t);
    line("doc-sync (lands)", `${fmt(p50, " ms p50")}   ${fmt(p95, " ms p95")}`);
  }

  // ---------------------------------------------------- 2. concurrent triggers
  header("2. Concurrent POST /runs (operator fans out work)");
  for (const k of [3, 6, 10]) {
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: k }, () => post("/runs", { taskId: "doc-sync" })),
    );
    const wall = performance.now() - t0;
    line(`${k} concurrent triggers`, `${fmt(wall, " ms wall")}  (${fmt(wall / k, " ms/run amortised")})`);
  }

  // ---------------------------------------------------- 3. operator round trips
  header("3. Operator actions (console's actual calls)");
  {
    // bootstrap = the console's 4 parallel GETs
    const t: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await Promise.all([
        fetch(`${BASE}/metrics`).then((r) => r.json()),
        fetch(`${BASE}/chats`).then((r) => r.json()),
        fetch(`${BASE}/runs`).then((r) => r.json()),
        fetch(`${BASE}/runs/timeline`).then((r) => r.json()),
      ]);
      t.push(performance.now() - t0);
    }
    const { p50, p95 } = pcts(t);
    line("full bootstrap (4 GETs)", `${fmt(p50, " ms p50")}   ${fmt(p95, " ms p95")}`);
  }
  {
    // park a gated run, approve it over HTTP, time the full resume round trip
    const parked = await post("/runs", { taskId: "content-draft" });
    const t0 = performance.now();
    const out = await post(`/runs/${parked.runId}/gates/public_publish`, {
      decision: "approve",
      note: "bench",
    });
    line("gate approve → resume → verdict", `${fmt(performance.now() - t0, " ms")}  (run: ${out.run.status})`);
  }
  {
    // decline path
    const parked = await post("/runs", { taskId: "content-draft" });
    const t0 = performance.now();
    const out = await post(`/runs/${parked.runId}/gates/public_publish`, {
      decision: "deny",
      note: "bench-deny",
    });
    line("gate deny → close", `${fmt(performance.now() - t0, " ms")}  (run: ${out.run.verdict ?? out.run.status})`);
  }

  // ---------------------------------------------------- 4. sustained mixed load
  header("4. Sustained mixed load (runs + reads interleaved, 30 s worth of ops)");
  {
    const t0 = performance.now();
    let reads = 0;
    const runsP = Promise.all(
      Array.from({ length: 6 }, () => post("/runs", { taskId: "alert-triage" })),
    );
    // hammer reads while runs execute — the operator refreshing during work
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        await fetch(`${BASE}/runs`).then((r) => r.json());
        reads++;
      }
    })();
    await runsP;
    stop = true;
    await reader;
    const wall = performance.now() - t0;
    line("6 runs + parallel read loop", `${fmt(wall, " ms wall")}, ${fmt(reads)} reads served alongside`);
    line("reads/sec during active runs", fmt(reads / (wall / 1000), " req/s"));
  }

  const runs = (await (await fetch(`${BASE}/runs`)).json()) as unknown[];
  line("\n  ledger size at end", String(runs.length) + " runs");
  server.close();
  console.log("\ndone.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

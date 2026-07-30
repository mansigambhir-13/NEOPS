/**
 * Deep backend benchmark — the layers the engine microbench (report.ts) does NOT see.
 *
 * report.ts §4 shows beautiful concurrency, but it mocks the snapshot and the
 * successCheck. The REAL run path spawns git + shell subprocesses, and if those are
 * synchronous they block the entire Node event loop — every other run and every HTTP
 * request in the control plane stalls behind them. This bench measures:
 *
 *   1. Layer costs: worktree creation, git snapshot, shell successCheck
 *   2. Full demo-scenario runs (real worktree, real check) — serial p50
 *   3. Event-loop blocking DURING a run (max tick delay of a 5ms heartbeat)
 *   4. Concurrency scaling: K full runs at once — serialized vs overlapped
 *   5. Control-plane HTTP: GET /runs and gate-decision latency under load
 *
 * Run: npm run build && node dist/bench/backend.js
 */

import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";
import { ControlPlane } from "../src/server/controlPlane.js";
import { DEMO_SCENARIOS, fauxModels, makeDemoWorktree } from "../src/server/demo.js";
import { gitSnapshot } from "../src/pi/snapshot.js";
import { ShellSuccessCheckRunner } from "../src/successCheck.js";

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

// ---------------------------------------------------------------- 1. layer costs
async function benchLayers() {
  header("1. Layer costs (the subprocess tax)");
  const dirs: string[] = [];

  {
    const t: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const d = await makeDemoWorktree({ "a.md": "x\n" });
      t.push(performance.now() - t0);
      dirs.push(d);
    }
    const { p50 } = pcts(t);
    line("worktree create (init+commit)", fmt(p50, " ms p50"));
  }

  {
    const wt = dirs[0]!;
    const t: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await gitSnapshot(wt, []);
      t.push(performance.now() - t0);
    }
    line("git snapshot (add + 2×diff)", fmt(pcts(t).p50, " ms p50"));
  }

  {
    const runner = new ShellSuccessCheckRunner(10_000);
    const wt = dirs[0]!;
    const t: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await runner.run("test -f a.md", wt);
      t.push(performance.now() - t0);
    }
    line("shell successCheck (test -f)", fmt(pcts(t).p50, " ms p50"));
  }

  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ------------------------------------------------- helpers: one full demo run
async function oneRun(plane: ControlPlane): Promise<void> {
  await plane.execute("doc-sync");
}

// ------------------------------------------ 2. full-run serial + 3. loop blocking
async function benchFullRuns() {
  header("2. Full demo run (real pi loop + worktree + git + shell check)");
  const plane = new ControlPlane({ port: 0, mode: "demo" });
  const t: number[] = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    await oneRun(plane);
    t.push(performance.now() - t0);
  }
  const { p50, p95 } = pcts(t);
  line("full run", `${fmt(p50, " ms p50")}   ${fmt(p95, " ms p95")}`);

  header("3. Event-loop blocking during a run (5ms heartbeat, max delay)");
  let maxLag = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    const lag = now - last - 5;
    if (lag > maxLag) maxLag = lag;
    last = now;
  }, 5);
  await oneRun(plane);
  clearInterval(tick);
  line("max heartbeat delay", fmt(maxLag, " ms"));
  console.log(
    maxLag > 25
      ? "  ⚠ the event loop stalls this long — every concurrent run and HTTP request waits"
      : "  ✓ event loop stays responsive during a run",
  );
}

// ---------------------------------------------------------- 4. concurrency scaling
async function benchConcurrency() {
  header("4. Concurrency scaling — K full runs at once (NFR: 5 now, 50 later)");
  const plane = new ControlPlane({ port: 0, mode: "demo" });
  // warm-up
  await oneRun(plane);
  const single = await (async () => {
    const t0 = performance.now();
    await oneRun(plane);
    return performance.now() - t0;
  })();
  for (const k of [2, 5, 10]) {
    const t0 = performance.now();
    await Promise.all(Array.from({ length: k }, () => oneRun(plane)));
    const wall = performance.now() - t0;
    const ideal = single; // perfectly overlapped subprocesses ≈ single-run wall
    const serialized = single * k; // fully event-loop-serialized
    const ratio = wall / serialized;
    line(
      `${k} concurrent`,
      `${fmt(wall, " ms wall")}  (1 run = ${fmt(single, " ms")}; serialized would be ${fmt(serialized, " ms")}; ratio ${fmt(ratio)})`,
    );
  }
  console.log("  ratio ≈ 1.0 → fully serialized (blocking); ratio ≈ 1/K → fully overlapped");
}

// ---------------------------------------------------------- 5. control-plane HTTP
async function benchHttp() {
  header("5. Control-plane HTTP under load");
  const port = 8123;
  const plane = new ControlPlane({ port, mode: "demo" });
  await plane.seed();
  const server = plane.serve();
  await new Promise((r) => setTimeout(r, 200));
  const base = `http://localhost:${port}`;

  {
    // 300 GET /runs, 10 in flight
    const lat: number[] = [];
    const t0 = performance.now();
    for (let batch = 0; batch < 30; batch++) {
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          const s = performance.now();
          const res = await fetch(`${base}/runs`);
          await res.json();
          lat.push(performance.now() - s);
        }),
      );
    }
    const wall = performance.now() - t0;
    const { p50, p95 } = pcts(lat);
    line("GET /runs ×300 (10 in flight)", `${fmt(p50, " ms p50")}  ${fmt(p95, " ms p95")}  ${fmt(300 / (wall / 1000), " req/s")}`);
  }

  {
    // gate decision (includes a full worker RESUME server-side)
    const runs = (await (await fetch(`${base}/runs`)).json()) as { runId: string; status: string }[];
    const awaiting = runs.find((r) => r.status === "awaiting_human");
    if (awaiting) {
      const s = performance.now();
      await fetch(`${base}/runs/${awaiting.runId}/gates/public_publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", note: "bench" }),
      });
      line("POST gate approve (incl. worker resume)", fmt(performance.now() - s, " ms"));
    }
  }

  server.close();
}

async function main() {
  console.log("=============================================");
  console.log(" NEOP backend deep benchmark (subprocess path)");
  console.log("=============================================");
  console.log(` node ${process.version}`);
  await benchLayers();
  await benchFullRuns();
  await benchConcurrency();
  await benchHttp();
  console.log("\ndone.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

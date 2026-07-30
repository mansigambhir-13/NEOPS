/**
 * Quick Build performance: the factory's own latencies.
 *   1. loader micro: loadRegistry / resolveTemplate / generateIndex
 *   2. spawn + worktree lifecycle (real git)
 *   3. HTTP through the plane: /registry, /quickbuild/spawn, /build (scripted
 *      Foreman = the full worker loop + git + spec + spawn), sequential + concurrent
 *
 * Run: npm run build && node dist/bench/quickbuild.js
 */

import { performance } from "node:perf_hooks";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRegistry, resolveTemplate, generateIndex } from "../src/quickbuild/registry.js";
import { materializeWorktree, removeWorktree, spawnNeop } from "../src/quickbuild/spawn.js";
import { ControlPlane } from "../src/server/controlPlane.js";

function fmt(n: number, unit = "") {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 }) + unit;
}
function line(l: string, v: string) {
  console.log("  " + l.padEnd(46) + v);
}
function header(t: string) {
  console.log("\n" + t + "\n" + "-".repeat(t.length));
}
function pcts(s0: number[]) {
  const s = [...s0].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

const REG = resolve("registry");

function tempRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "neop-qbperf-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d });
  git("init", "-q");
  git("config", "user.email", "b@b");
  git("config", "user.name", "b");
  cpSync(REG, join(d, "registry"), { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return d;
}

async function main() {
  console.log("=================================================");
  console.log(" Quick Build performance (loader → spawn → HTTP)");
  console.log("=================================================");
  console.log(` node ${process.version}`);

  header("1. Loader micro (pure functions over markdown)");
  {
    let t0 = performance.now();
    for (let i = 0; i < 200; i++) loadRegistry(REG);
    line("loadRegistry (11 tools, 4 templates)", fmt((performance.now() - t0) / 200, " ms"));
    const reg = loadRegistry(REG);
    t0 = performance.now();
    for (let i = 0; i < 20_000; i++) resolveTemplate(reg, "marketing", { withOptional: ["publish_post"] });
    line("resolveTemplate (+pins, invariants)", fmt(((performance.now() - t0) * 1000) / 20_000, " µs"));
    t0 = performance.now();
    for (let i = 0; i < 5_000; i++) generateIndex(reg);
    line("generateIndex", fmt(((performance.now() - t0) * 1000) / 5_000, " µs"));
  }

  header("2. Spawn + worktree (real git)");
  {
    const repo = tempRepo();
    const reg = loadRegistry(join(repo, "registry"));
    const t: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      spawnNeop(repo, reg, { slug: `bench/s-${i}`, template: "coding", owner: "b" });
      t.push(performance.now() - t0);
    }
    line("spawnNeop (resolve+pins+spec+marker)", fmt(pcts(t).p50, " ms p50"));
    const w: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const wt = materializeWorktree(repo, "bench/s-0", `r${i}`);
      w.push(performance.now() - t0);
      removeWorktree(repo, wt);
    }
    line("worktree add (registry-sized repo)", fmt(pcts(w).p50, " ms p50"));
    rmSync(repo, { recursive: true, force: true });
  }

  header("3. Through the plane (HTTP)");
  {
    const repo = tempRepo();
    const port = 8135;
    const plane = new ControlPlane({ port, mode: "demo", registryDir: join(repo, "registry"), repoRoot: repo });
    const server = plane.serve();
    await new Promise((r) => setTimeout(r, 150));
    const base = `http://localhost:${port}`;
    const post = async (p: string, b: unknown) => {
      const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      if (!res.ok) throw new Error(`${p} ${res.status}: ${await res.text()}`);
      return res.json();
    };

    {
      const t: number[] = [];
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        await (await fetch(`${base}/registry`)).json();
        t.push(performance.now() - t0);
      }
      const { p50, p95 } = pcts(t);
      line("GET /registry", `${fmt(p50, " ms p50")}  ${fmt(p95, " ms p95")}`);
    }
    {
      const t: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        await post("/quickbuild/spawn", { slug: `bench/h-${i}`, template: "coding", owner: "b" });
        t.push(performance.now() - t0);
      }
      line("POST /quickbuild/spawn", fmt(pcts(t).p50, " ms p50"));
    }
    {
      // the chat→Foreman wire: full worker loop + worktree + spec + spawn, per call
      const t: number[] = [];
      for (let i = 0; i < 8; i++) {
        const t0 = performance.now();
        await post("/build", { requirement: `bench requirement ${i}` });
        t.push(performance.now() - t0);
      }
      const { p50, p95 } = pcts(t);
      line("POST /build (scripted Foreman, e2e)", `${fmt(p50, " ms p50")}  ${fmt(p95, " ms p95")}`);
      const t0 = performance.now();
      await Promise.all([1, 2, 3].map((i) => post("/build", { requirement: `parallel ${i}` })));
      line("3 concurrent /build", fmt(performance.now() - t0, " ms wall"));
    }
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("\ndone.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

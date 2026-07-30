/**
 * Quick Build over HTTP — the workshop UI's contract with the plane:
 * GET /registry serves the markdown library; POST /quickbuild/spawn is a REAL
 * spawn whose refusals (taint, ground truth) surface verbatim as 409s.
 */

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "neop-qbapi-"));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  cpSync(resolve("registry"), join(d, "registry"), { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return d;
}

describe("quick build HTTP surface", () => {
  it("serves the registry, refuses bad spawns with the resolver's words, spawns good ones", async () => {
    const port = 8129;
    const r = repo();
    const plane = new ControlPlane({ port, mode: "demo", registryDir: join(r, "registry"), repoRoot: r });
    const server = plane.serve();
    await new Promise((res) => setTimeout(res, 100));
    const base = `http://localhost:${port}`;
    try {
      // the library
      const reg = (await (await fetch(`${base}/registry`)).json()) as { tools: { name: string; taint: string }[]; templates: { id: string }[] };
      expect(reg.tools.length).toBeGreaterThanOrEqual(11);
      expect(reg.tools.find((t) => t.name === "read_inbox")?.taint).toBe("untrusted");
      expect(reg.templates.map((t) => t.id)).toContain("marketing");

      // spawn refused: marketing needs ground truth
      const noGt = await fetch(`${base}/quickbuild/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "acme/mkt", template: "marketing", owner: "t" }),
      });
      expect(noGt.status).toBe(409);
      expect(((await noGt.json()) as { error: string }).error).toMatch(/ground truth missing/);

      // spawn lands: coding has no ground-truth requirement
      const ok = await fetch(`${base}/quickbuild/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "acme/fixer", template: "coding", owner: "t" }),
      });
      expect(ok.status).toBe(201);
      const body = (await ok.json()) as { pins: Record<string, string> };
      expect(body.pins["run_build"]).toBe("1.0.0");

      // the fleet shows it
      const fleet = (await (await fetch(`${base}/fleet`)).json()) as { slug: string }[];
      expect(fleet.map((f) => f.slug)).toContain("acme/fixer");

      // duplicate spawn refused
      const dup = await fetch(`${base}/quickbuild/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "acme/fixer", template: "coding", owner: "t" }),
      });
      expect(dup.status).toBe(409);
    } finally {
      server.close();
    }
  });

  it("POST /build runs the (scripted) Foreman end to end: requirement in, spawned NEOP out", async () => {
    const port = 8131;
    const r = repo();
    const plane = new ControlPlane({ port, mode: "demo", registryDir: join(r, "registry"), repoRoot: r });
    const server = plane.serve();
    await new Promise((res) => setTimeout(res, 100));
    try {
      const res = await fetch(`http://localhost:${port}/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirement: "a NEOP that keeps the changelog fresh", owner: "t" }),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { status: string; spawned: string[]; actions: { tool: string }[] };
      expect(out.status).toBe("landed");
      expect(out.spawned.length).toBe(1);
      expect(out.spawned[0]).toMatch(/^demo\/req-/);
      // the transcript shows the Foreman's real actions
      expect(out.actions.map((a) => a.tool)).toEqual(
        expect.arrayContaining(["read_registry", "write_spec", "spawn_neop"]),
      );

      // the fleet knows it; reap removes worktrees without deleting the spec
      const fleet = (await (await fetch(`http://localhost:${port}/fleet`)).json()) as { slug: string }[];
      expect(fleet.map((f) => f.slug)).toContain(out.spawned[0]);
      const reap = await fetch(`http://localhost:${port}/quickbuild/reap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: out.spawned[0] }),
      });
      expect(reap.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("bootstrapRepo: creates a git repo on a bare volume dir and syncs on re-run", async () => {
    const { ensureQuickbuildRepo } = await import("../src/server/bootstrapRepo.js");
    const vol = mkdtempSync(join(tmpdir(), "neop-vol-"));
    dirs.push(vol);
    const repoRoot = join(vol, "repo");
    const first = ensureQuickbuildRepo(repoRoot, { registryDir: resolve("registry") });
    expect(first.created).toBe(true);
    // it is a real repo with a commit — the Foreman's pinned-ref boot works
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // second boot: reuse, no new commit when nothing changed
    const second = ensureQuickbuildRepo(repoRoot, { registryDir: resolve("registry") });
    expect(second.created).toBe(false);
    expect(second.synced).toBe(false);
    // registry edit in the image → re-sync commits
    writeFileSync(join(resolve("registry"), "..", ".tmp-probe"), ""); // no-op guard for lint
    rmSync(join(resolve("registry"), "..", ".tmp-probe"), { force: true });
    writeFileSync(join(repoRoot, "registry", "tools", "read-inbox.md"),
      execFileSync("cat", [join(resolve("registry"), "tools", "read-inbox.md")], { encoding: "utf8" }) + "\n<!-- image update -->\n");
    // simulate: image has NEW content vs volume — sync from a modified seed dir
    const seedDir = mkdtempSync(join(tmpdir(), "neop-seed-"));
    dirs.push(seedDir);
    cpSync(resolve("registry"), seedDir, { recursive: true });
    writeFileSync(join(seedDir, "templates", "base.md"),
      execFileSync("cat", [join(resolve("registry"), "templates", "base.md")], { encoding: "utf8" }) + "\n<!-- v2 -->\n");
    const third = ensureQuickbuildRepo(repoRoot, { registryDir: seedDir });
    expect(third.synced).toBe(true);
  });
});

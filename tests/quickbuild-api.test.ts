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
});

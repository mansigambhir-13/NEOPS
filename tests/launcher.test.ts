/**
 * Launch pad — a spawned NEOP becomes its own container. The docker calls are
 * live-proven; here we pin the PURE parts: the create payload (the security
 * posture of every child) and the env allowlist (what may cross the boundary).
 */

import { describe, it, expect } from "vitest";
import { createSpec, forwardEnv, DockerLauncher } from "../src/server/launcher.js";
import { ControlPlane } from "../src/server/controlPlane.js";
import { loadRegistryFromRef } from "../src/quickbuild/registry.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cfg = {
  image: "neop:local",
  volume: "neops_neop-data",
  socketPath: "/nonexistent.sock",
  env: {
    OPENROUTER_API_KEY: "sk-test",
    NEOP_AUTONOMY: "full",
    NEOP_SECRET_MANSI_RESEND_KEY: "re_x",
    NEOP_ADAPTER_SEND_EMAIL: "resend",
    HOME: "/home/x",           // must NOT cross
    NEOP_ADMIN_TOKEN: "secret", // must NOT cross
    PATH: "/bin",
  },
};

describe("launch pad", () => {
  it("children are tighter than the plane: CapDrop ALL, no-new-privileges, fixed Cmd, no socket", () => {
    const { name, body } = createSpec("acme/ai-brief", cfg);
    expect(name).toMatch(/^neop-run-acme-ai-brief-/);
    expect(body.Cmd).toEqual(["node", "dist/bin/neop.js", "run", "acme/ai-brief"]);
    const hc = body.HostConfig as Record<string, unknown>;
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(hc.Binds).toEqual(["neops_neop-data:/data"]); // data only — never the docker socket
  });

  it("slug shape is validated — no shell, no traversal, no flags", () => {
    for (const bad of ["../etc", "a b/c", "acme", "acme/x;rm", "-rf/x", "a/b/c"]) {
      expect(() => createSpec(bad, cfg)).toThrow(/bad slug/);
    }
  });

  it("env allowlist: keys+models+adapters+secrets cross; admin token and host env never do", () => {
    const env = forwardEnv(cfg.env);
    expect(env).toContain("OPENROUTER_API_KEY=sk-test");
    expect(env).toContain("NEOP_AUTONOMY=full");
    expect(env).toContain("NEOP_SECRET_MANSI_RESEND_KEY=re_x");
    expect(env).toContain("NEOP_REPO_ROOT=/data/repo");
    expect(env.join("\n")).not.toContain("ADMIN_TOKEN");
    expect(env.join("\n")).not.toContain("HOME=");
    expect(env.join("\n")).not.toContain("PATH=");
  });

  it("no socket → not available (the plane 501s instead of guessing)", () => {
    expect(new DockerLauncher(cfg).available()).toBe(false);
  });

  it("tracker: dup-launch 409s while running; status served from memory; auto-remove on exit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "neop-launch-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    cpSync(resolve("registry"), join(repo, "registry"), { recursive: true });
    mkdirSync(join(repo, "neops", "acme", "x", "ground-truth"), { recursive: true });
    writeFileSync(join(repo, "neops", "acme", "x", "ground-truth", "facts.md"), "f\n");
    writeFileSync(join(repo, "neops", "acme", "x", "ground-truth", "brand.md"), "b\n");
    writeFileSync(join(repo, "neops", "acme", "x", "spec.md"), "---\nslug: acme/x\ntemplate: ops\nowner: t\n---\n\n# x\n");
    git("add", "-A"); git("commit", "-qm", "seed");

    let removed = 0;
    let nLaunch = 0;
    let releaseWait!: () => void;
    const fake = {
      available: () => true,
      launch: async () => ({ id: (++nLaunch % 2 ? "a" : "b").repeat(24), name: `neop-run-acme-x-t${nLaunch}` }),
      wait: () => new Promise<number>((r) => { releaseWait = () => r(0); }),
      harvest: async () => { removed += 1; return { running: false, exitCode: 0, outcome: { status: "landed" }, logsTail: "ok" }; },
      status: async () => { throw new Error("must not hit the socket for tracked launches"); },
      remove: async () => {},
    } as unknown as DockerLauncher;

    const port = 8143;
    const plane = new ControlPlane({ port, mode: "demo", repoRoot: repo, launcher: fake });
    const server = plane.serve();
    await new Promise((r) => setTimeout(r, 100));
    const base = `http://localhost:${port}`;
    try {
      const post = (body: unknown) =>
        fetch(`${base}/quickbuild/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const first = await post({ slug: "acme/x" });
      expect(first.status).toBe(200);
      const dup = await post({ slug: "acme/x" });
      expect(dup.status).toBe(409); // double-click cannot double-spend
      const running = (await (await fetch(`${base}/quickbuild/launch/${"a".repeat(24)}`)).json()) as { running: boolean };
      expect(running.running).toBe(true); // from memory — fake status() would have thrown
      releaseWait();
      await new Promise((r) => setTimeout(r, 30));
      const done = (await (await fetch(`${base}/quickbuild/launch/${"a".repeat(24)}`)).json()) as { outcome: { status: string } };
      expect(done.outcome.status).toBe("landed");
      expect(removed).toBe(1); // harvested exactly once → container auto-removed
      const again = await post({ slug: "acme/x" });
      expect(again.status).toBe(200); // finished → relaunch allowed
      const list = (await (await fetch(`${base}/quickbuild/launches`)).json()) as unknown[];
      expect(list.length).toBe(2);
    } finally {
      server.close();
    }
  });

  it("pinned registry is cached by sha — same object back, no re-parse", () => {
    const repo = mkdtempSync(join(tmpdir(), "neop-cache-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    cpSync(resolve("registry"), join(repo, "registry"), { recursive: true });
    git("add", "-A"); git("commit", "-qm", "seed");
    const a = loadRegistryFromRef(repo, "HEAD");
    const b = loadRegistryFromRef(repo, "HEAD");
    expect(b).toBe(a);
  });
});

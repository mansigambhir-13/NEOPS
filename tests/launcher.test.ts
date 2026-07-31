/**
 * Launch pad — a spawned NEOP becomes its own container. The docker calls are
 * live-proven; here we pin the PURE parts: the create payload (the security
 * posture of every child) and the env allowlist (what may cross the boundary).
 */

import { describe, it, expect } from "vitest";
import { createSpec, forwardEnv, DockerLauncher } from "../src/server/launcher.js";

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
});

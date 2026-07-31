import { describe, it, expect } from "vitest";
import { gate, reversibilityOf, DEFAULT_STANDING_DENIALS } from "../src/policy.js";
import type { GateContext } from "../src/policy.js";
import { action } from "./fixtures.js";

const ctx: GateContext = {
  worktreeRoot: "/runs/run-1/wt",
  egressAllowlist: ["api.internal.example"],
};

describe("§2.1 reversibility gate", () => {
  it("allows reversible action classes", () => {
    const d = gate(action({ tool: "edit_file", declaredClass: "workspace_write", targetPath: "/runs/run-1/wt/a.md" }), ctx);
    expect(d.verdict).toBe("allow");
  });

  it("blocks irreversible action classes for a human", () => {
    const d = gate(action({ tool: "publish_post", declaredClass: "public_publish" }), ctx);
    expect(d.verdict).toBe("block_for_human");
  });

  it("FAILS CLOSED on unknown/unclassified action — treated as irreversible", () => {
    const d = gate(action({ tool: "mystery_tool" }), ctx); // no declaredClass
    expect(d.verdict).toBe("block_for_human");
    expect(reversibilityOf("unknown")).toBe("irreversible");
  });

  it("every irreversible class resolves to block, every reversible to allow", () => {
    const irreversible = ["public_publish", "external_email", "spend", "prod_write", "pr_merge"] as const;
    for (const c of irreversible) {
      expect(reversibilityOf(c)).toBe("irreversible");
    }
    const reversible = ["read", "workspace_write", "internal_post", "pr_open", "test_run"] as const;
    for (const c of reversible) {
      expect(reversibilityOf(c)).toBe("reversible");
    }
  });
});

describe("§8.3 standing denials — non-overridable floor", () => {
  it("hard-denies force-push regardless of class", () => {
    const d = gate(action({ tool: "git", declaredClass: "workspace_write", args: { cmd: "push --force origin main" } }), ctx);
    expect(d.verdict).toBe("deny");
    expect(d.verdict === "deny" && d.reason).toContain("no-force-push");
  });

  it("hard-denies merge to main", () => {
    const d = gate(action({ tool: "git", declaredClass: "workspace_write", args: { cmd: "merge feature into main" } }), ctx);
    expect(d.verdict).toBe("deny");
  });

  it("hard-denies destructive SQL (DROP / unbounded DELETE)", () => {
    expect(gate(action({ tool: "db", declaredClass: "prod_write", args: { q: "DROP TABLE users" } }), ctx).verdict).toBe("deny");
    expect(gate(action({ tool: "db", declaredClass: "prod_write", args: { q: "DELETE FROM users" } }), ctx).verdict).toBe("deny");
  });

  it("allows a bounded DELETE (has WHERE) to reach the normal gate", () => {
    // prod_write is still irreversible, so it blocks for human — but is NOT hard-denied.
    const d = gate(action({ tool: "db", declaredClass: "prod_write", args: { q: "DELETE FROM users WHERE id=1" } }), ctx);
    expect(d.verdict).toBe("block_for_human");
  });

  it("hard-denies reads of secret files", () => {
    const d = gate(action({ tool: "read_file", declaredClass: "read", targetPath: "/runs/run-1/wt/.env" }), ctx);
    expect(d.verdict).toBe("deny");
    expect(d.verdict === "deny" && d.reason).toContain("no-secret-reads");
  });

  it("the denial set is non-empty and each has an id + reason", () => {
    expect(DEFAULT_STANDING_DENIALS.length).toBeGreaterThan(0);
    for (const dnl of DEFAULT_STANDING_DENIALS) {
      expect(dnl.id).toBeTruthy();
      expect(dnl.reason).toBeTruthy();
    }
  });
});

describe("worktree jail + egress allowlist", () => {
  it("denies a write outside the worktree", () => {
    const d = gate(action({ tool: "edit_file", declaredClass: "workspace_write", targetPath: "/etc/passwd" }), ctx);
    expect(d.verdict).toBe("deny");
    expect(d.verdict === "deny" && d.reason).toContain("outside worktree");
  });

  it("allows a write inside the worktree", () => {
    const d = gate(action({ tool: "edit_file", declaredClass: "workspace_write", targetPath: "/runs/run-1/wt/sub/x.md" }), ctx);
    expect(d.verdict).toBe("allow");
  });

  it("denies a .. escape that resolves outside", () => {
    const d = gate(action({ tool: "edit_file", declaredClass: "workspace_write", targetPath: "/runs/run-1/wt-evil/x" }), ctx);
    expect(d.verdict).toBe("deny");
  });

  it("denies egress to a non-allowlisted host", () => {
    const d = gate(action({ tool: "read_file", declaredClass: "read", targetHost: "evil.example" }), ctx);
    expect(d.verdict).toBe("deny");
  });

  it("allows egress to an allowlisted host", () => {
    const d = gate(action({ tool: "read_file", declaredClass: "read", targetHost: "api.internal.example" }), ctx);
    expect(d.verdict).toBe("allow");
  });
});it("prose containing 'update' is NOT SQL — the live ops-NEOP incident", () => {
    const d = gate(
      { tool: "draft_post", declaredClass: "workspace_write", targetPath: "/wt/ops/summary.md",
        args: { path: "ops/summary.md", content: "Operations update: all systems nominal. No blockers." } },
      { worktreeRoot: "/wt", egressAllowlist: [] },
    );
    expect(d.verdict).toBe("allow");
  });

  it("real unbounded SQL still denied", () => {
    const d = gate(
      { tool: "db", declaredClass: "prod_write", args: { sql: "UPDATE users SET plan = 'free'" } },
      { worktreeRoot: "/wt", egressAllowlist: [] },
    );
    expect(d.verdict).toBe("deny");
    expect("reason" in d && d.reason).toContain("no-destructive-sql");
  });

  

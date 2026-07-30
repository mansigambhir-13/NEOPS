/**
 * NEOP core domain types.
 *
 * These are the vocabulary the three invariants are written in. Kept dependency-free
 * so the policy gate, task loader, verifier, and lifecycle all speak the same nouns.
 */

/**
 * Reversibility is the ONLY axis the gate cares about (§2.1).
 * "Can a human undo this in five minutes?" — not "is this important".
 */
export type Reversibility = "reversible" | "irreversible";

/**
 * An action class names a category of side-effect a tool can produce. Every tool
 * declares exactly one. The class → reversibility mapping lives in the policy
 * registry, not on the tool, so classification is auditable in one place.
 *
 * `unknown` is the fail-closed sentinel: a tool that ships without a declared class
 * resolves to `unknown`, which the gate treats as irreversible (§2.1).
 */
export type ActionClass =
  | "read" // read-only: fetch, search, inspect
  | "workspace_write" // write inside the run's git worktree only
  | "internal_post" // post to an internal/non-public channel
  | "pr_open" // open a PR (reversible: nobody depends on it yet)
  | "test_run" // execute tests / build
  | "public_publish" // IRREVERSIBLE: publish to a public surface
  | "external_email" // IRREVERSIBLE: send mail outside the org
  | "spend" // IRREVERSIBLE: costs money
  | "prod_write" // IRREVERSIBLE: writes production state
  | "pr_merge" // IRREVERSIBLE: merges to a protected branch
  | "unknown"; // fail-closed sentinel

/** The gate's verdict for a single action. */
export type GateDecision =
  | { verdict: "allow"; class: ActionClass }
  | { verdict: "block_for_human"; class: ActionClass; reason: string }
  | { verdict: "deny"; class: ActionClass; reason: string };

/** A concrete action the agent wants to take, presented to the gate. */
export interface ActionRequest {
  /** The tool the agent is calling, e.g. "publish_post". */
  tool: string;
  /** Declared action class of the tool (from its contract), or "unknown". */
  declaredClass?: ActionClass;
  /** Free-form arguments — inspected only by standing-denial pattern checks. */
  args?: Record<string, unknown>;
  /** Absolute path the action would touch, if any (for worktree-jail checks). */
  targetPath?: string;
  /** Host the action would reach, if any (for egress allowlist checks). */
  targetHost?: string;
}

/** Human approval record for a blocked action (§5 step 5, §8.2). */
export interface Approval {
  runId: string;
  actionKey: string; // idempotency key: (task_id, logical_date, content_hash)
  decision: "approve" | "deny";
  approvedBy: string;
  ts: string; // ISO
  note?: string;
}

/** Terminal status of a run. */
export type RunStatus =
  | "admitted"
  | "running"
  | "awaiting_human"
  | "verifying"
  | "landed"
  | "quarantined"
  | "escalated"
  | "dropped";

/** The verifier's verdict (§6.1). Read-only, veto power. */
export interface Verdict {
  pass: boolean;
  /** Human-readable reasons — always populated, especially on fail. */
  reasons: string[];
  /** Flags the lifecycle acts on. */
  outOfScope: boolean;
  testsTampered: boolean;
  secretsSuspected: boolean;
}

/** What a completed agent execution produced, handed to verify + land. */
export interface RunArtifacts {
  /** Unified diff the run produced in its worktree. */
  diff: string;
  /** Paths touched, relative to the worktree root. */
  filesChanged: string[];
  /** successCheck command output + exit code (§2.2). */
  successCheck: { exitCode: number; stdout: string; stderr: string };
  /** Actions the agent attempted, in order (for audit + verifier context). */
  actions: ActionRequest[];
}

/** Token/turn accounting surfaced by the runtime for ceiling checks (§2.3). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  costUsd: number;
}

/**
 * The adapter seam.
 *
 * NEOP's engine never imports the pi SDK directly. It talks to this interface. The
 * real implementation (a thin wrapper over pi's AgentSession) is added once the
 * package is read and pinned (Appendix A.9). Until then, `fakeRuntime` implements it
 * deterministically so every invariant is testable without a key or a network.
 *
 * Crucially, the runtime does NOT decide policy. It surfaces each intended action to
 * the caller via `onAction` and only proceeds if the caller returns "allow". This
 * keeps the gate (policy.ts) as the single decision point — the runtime cannot
 * fail open by forgetting to check.
 */

import type { ActionRequest, RunArtifacts, Usage } from "../types.js";

/** The caller's ruling on an action the agent wants to take. */
export type ActionRuling =
  | { allow: true }
  | { allow: false; block: true; reason: string } // park for human
  | { allow: false; block: false; reason: string }; // hard deny, tell the agent

export interface RunSessionConfig {
  runId: string;
  /** Assembled system prompt (SOUL + task). */
  systemPrompt: string;
  /** The task's tool names — the runtime exposes exactly these, nothing inherited. */
  tools: string[];
  /** Scoped working directory = the git worktree. */
  cwd: string;
  /** Model id for the working turn (routing decided by caller). */
  model: string;
  /**
   * Policy hook. The runtime MUST await this before performing any tool action and
   * honour the ruling. This is how the gate stays in the loop.
   */
  onAction: (action: ActionRequest) => Promise<ActionRuling> | ActionRuling;
  /** Called after each model turn with cumulative usage (for ceiling checks). */
  onTurn?: (usage: Usage) => void | { steer: string } | Promise<void | { steer: string }>;
}

export interface SessionResult {
  artifacts: RunArtifacts;
  usage: Usage;
  stopReason: "done" | "blocked_for_human" | "ceiling" | "error";
  /** If stopReason === "blocked_for_human", the action awaiting approval. */
  pendingAction?: ActionRequest;
  error?: string;
}

export interface AgentRuntime {
  /** Run one agent session to completion or to a human-block. */
  runSession(config: RunSessionConfig): Promise<SessionResult>;

  /**
   * Run a COLD verification session (§6.1). Separate context, read-only, one turn.
   * Given a prompt, returns raw model text for the verifier to parse. The engine
   * uses a different (smaller) model here via config.model.
   */
  runVerification(config: {
    runId: string;
    prompt: string;
    model: string;
  }): Promise<{ text: string; usage: Usage }>;
}

/**
 * Deterministic AgentRuntime for tests and dry runs.
 *
 * A run is scripted as an ordered list of intended actions plus the artifacts it
 * would produce. The fake faithfully routes every action through `onAction` and
 * stops for a human the moment a ruling says to — exactly as the real runtime must.
 * This lets the lifecycle + policy + verifier be exercised end to end with no key.
 */

import type { ActionRequest, RunArtifacts, Usage } from "../types.js";
import type {
  AgentRuntime,
  RunSessionConfig,
  SessionResult,
} from "./AgentRuntime.js";

export interface ScriptedRun {
  /** Actions the agent will attempt, in order. */
  actions: ActionRequest[];
  /** Artifacts produced if the run completes (successCheck etc.). */
  artifacts: RunArtifacts;
  usage?: Usage;
}

/** Scripted verification response, keyed by nothing — one per runtime. */
export interface ScriptedVerification {
  text: string;
  usage?: Usage;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, turns: 0, costUsd: 0 };

export class FakeRuntime implements AgentRuntime {
  constructor(
    private readonly script: ScriptedRun,
    private readonly verification?: ScriptedVerification,
  ) {}

  async runSession(config: RunSessionConfig): Promise<SessionResult> {
    const performed: ActionRequest[] = [];
    const usage = this.script.usage ?? { ...ZERO_USAGE, turns: 1 };

    if (config.onTurn) await config.onTurn(usage);

    for (const action of this.script.actions) {
      // The runtime asks the gate. It cannot proceed without a ruling.
      const ruling = await config.onAction(action);
      if (ruling.allow) {
        performed.push(action);
        continue;
      }
      if (ruling.block) {
        return {
          artifacts: { ...this.script.artifacts, actions: performed },
          usage,
          stopReason: "blocked_for_human",
          pendingAction: action,
        };
      }
      // Hard deny: the agent is told; in the fake we simply skip and continue.
      // A real agent might adapt; the deterministic fake records and moves on.
    }

    return {
      artifacts: { ...this.script.artifacts, actions: performed },
      usage,
      stopReason: "done",
    };
  }

  async runVerification(): Promise<{ text: string; usage: Usage }> {
    if (!this.verification) {
      throw new Error("FakeRuntime.runVerification called but no verification script provided");
    }
    return {
      text: this.verification.text,
      usage: this.verification.usage ?? ZERO_USAGE,
    };
  }
}

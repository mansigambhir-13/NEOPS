/**
 * §2.3 Ceilings in code — checked BEFORE spend, not after.
 *
 * Budget exhaustion does not hard-abort mid-edit; it flips a flag the lifecycle
 * reads to inject a "summarise and stop" steer. Wall-clock and container limits are
 * enforced elsewhere (the container, §6.6) — this tracks the software-visible ones.
 */

import type { Usage } from "./types.js";

export interface CeilingConfig {
  maxTokens: number; // input+output combined
  maxSubagentDepth: number; // 0, 1, or 2
  wallClockMs: number;
  maxActions: number; // action-rate limit per run
}

export const DEFAULT_CEILINGS: CeilingConfig = {
  maxTokens: 400_000,
  maxSubagentDepth: 2,
  wallClockMs: 45 * 60_000, // 45 min, §6.6
  maxActions: 50,
};

export type CeilingBreach =
  | { kind: "tokens"; limit: number; observed: number }
  | { kind: "wall_clock"; limit: number; observed: number }
  | { kind: "actions"; limit: number; observed: number }
  | { kind: "subagent_depth"; limit: number; observed: number };

/**
 * Tracks spend across a run and answers "would this next step breach a ceiling?"
 * The lifecycle checks BEFORE each turn / action / spawn.
 */
export class CeilingTracker {
  private actions = 0;
  private tokens = 0;
  private readonly startedAt: number;

  constructor(
    private readonly cfg: CeilingConfig,
    now: number,
  ) {
    this.startedAt = now;
  }

  /** Fold in usage reported by the runtime after a turn. */
  record(usage: Usage): void {
    this.tokens = usage.inputTokens + usage.outputTokens;
  }

  /** Called before an action executes; increments and returns a breach if over. */
  admitAction(now: number): CeilingBreach | null {
    const wall = this.checkWall(now);
    if (wall) return wall;
    if (this.actions + 1 > this.cfg.maxActions) {
      return { kind: "actions", limit: this.cfg.maxActions, observed: this.actions + 1 };
    }
    this.actions += 1;
    return null;
  }

  /** Called before a model turn; returns a breach if token/wall budget is spent. */
  admitTurn(now: number): CeilingBreach | null {
    const wall = this.checkWall(now);
    if (wall) return wall;
    if (this.tokens > this.cfg.maxTokens) {
      return { kind: "tokens", limit: this.cfg.maxTokens, observed: this.tokens };
    }
    return null;
  }

  /** Called before spawning a sub-agent (§9). Depth is 1-based for the child. */
  admitSubagent(childDepth: number): CeilingBreach | null {
    if (childDepth > this.cfg.maxSubagentDepth) {
      return { kind: "subagent_depth", limit: this.cfg.maxSubagentDepth, observed: childDepth };
    }
    return null;
  }

  private checkWall(now: number): CeilingBreach | null {
    const elapsed = now - this.startedAt;
    if (elapsed > this.cfg.wallClockMs) {
      return { kind: "wall_clock", limit: this.cfg.wallClockMs, observed: elapsed };
    }
    return null;
  }
}

/** Merge a task's optional overrides onto the defaults. */
export function resolveCeilings(overrides?: Partial<CeilingConfig>): CeilingConfig {
  return { ...DEFAULT_CEILINGS, ...(overrides ?? {}) };
}

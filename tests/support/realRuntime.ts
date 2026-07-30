/**
 * A NON-fake AgentRuntime for end-to-end integration + performance measurement.
 *
 * Unlike FakeRuntime, this performs REAL filesystem writes inside the run's git
 * worktree and computes a REAL git diff. It still routes every write through the
 * gate via onAction — exactly as the pi binding must. There is no LLM here: the
 * "plan" is scripted, so runs are deterministic and timing measures the ENGINE, not
 * a model. That is the point — it isolates NEOP's own overhead.
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import type { ActionRequest, RunArtifacts, Usage } from "../../src/types.js";
import type { AgentRuntime, RunSessionConfig, SessionResult } from "../../src/runtime/AgentRuntime.js";

export interface PlannedEdit {
  /** Path relative to the worktree. */
  path: string;
  content: string;
  /** Tool the agent would call (defaults to edit_file). */
  tool?: string;
}

export interface RealRunPlan {
  edits: PlannedEdit[];
  /** Extra non-file actions to attempt (e.g. a publish or a force-push probe). */
  extraActions?: ActionRequest[];
  /** Verifier response text (stubbed cold model). */
  verification: string;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const ZERO: Usage = { inputTokens: 1200, outputTokens: 300, turns: 1, costUsd: 0 };

export class RealRuntime implements AgentRuntime {
  constructor(private readonly plan: RealRunPlan) {}

  async runSession(config: RunSessionConfig): Promise<SessionResult> {
    const performed: ActionRequest[] = [];
    const wt = config.cwd;

    // extra probe actions first (so a denial/block is observed before edits)
    for (const a of this.plan.extraActions ?? []) {
      const ruling = await config.onAction(a);
      if (ruling.allow) performed.push(a);
      else if (ruling.block) {
        return {
          artifacts: this.snapshot(wt, performed),
          usage: ZERO,
          stopReason: "blocked_for_human",
          pendingAction: a,
        };
      }
      // hard deny: skip, continue
    }

    for (const edit of this.plan.edits) {
      const abs = isAbsolute(edit.path) ? edit.path : join(wt, edit.path);
      const action: ActionRequest = {
        tool: edit.tool ?? "edit_file",
        targetPath: abs,
        args: { path: edit.path },
      };
      const ruling = await config.onAction(action);
      if (ruling.allow) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, edit.content, "utf8");
        performed.push(action);
      } else if (ruling.block) {
        return {
          artifacts: this.snapshot(wt, performed),
          usage: ZERO,
          stopReason: "blocked_for_human",
          pendingAction: action,
        };
      }
      // hard deny: the write never happens; continue
    }

    return { artifacts: this.snapshot(wt, performed), usage: ZERO, stopReason: "done" };
  }

  /** Stage everything and read the real diff + changed file list from git. */
  private snapshot(wt: string, performed: ActionRequest[]): RunArtifacts {
    git(wt, "add -A");
    const diff = git(wt, "diff --cached");
    const names = git(wt, "diff --cached --name-only").trim();
    const filesChanged = names ? names.split("\n") : [];
    return {
      diff,
      filesChanged,
      // successCheck is run independently by the lifecycle (§2.2) — placeholder here.
      successCheck: { exitCode: 0, stdout: "", stderr: "" },
      actions: performed,
    };
  }

  async runVerification(): Promise<{ text: string; usage: Usage }> {
    return { text: this.plan.verification, usage: ZERO };
  }
}

/** Create a throwaway git repo to act as the base + worktree. Returns its path. */
export function makeRepo(dir: string, seedFiles: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init -q");
  git(dir, 'config user.email "t@t.t"');
  git(dir, 'config user.name "t"');
  for (const [rel, content] of Object.entries(seedFiles)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  git(dir, "add -A");
  git(dir, "commit -q -m seed --allow-empty");
}

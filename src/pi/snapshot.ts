/**
 * Run artifacts come from git, not from the agent's word. After the doer stops
 * touching files we stage the worktree and read the real diff — the same evidence
 * the verifier and the human see. (§5 assemble→…→land; §6.1 evidence.)
 */

import { execSync } from "node:child_process";
import type { ActionRequest, RunArtifacts } from "../types.js";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Stage everything and read the real diff + changed file list from git. */
export function gitSnapshot(worktreeRoot: string, performed: ActionRequest[]): RunArtifacts {
  git(worktreeRoot, "add -A");
  const diff = git(worktreeRoot, "diff --cached");
  const names = git(worktreeRoot, "diff --cached --name-only").trim();
  const filesChanged = names ? names.split("\n") : [];
  return {
    diff,
    filesChanged,
    // successCheck is run independently by the worker (§2.2) — placeholder here.
    successCheck: { exitCode: 0, stdout: "", stderr: "" },
    actions: performed,
  };
}

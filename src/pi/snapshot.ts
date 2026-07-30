/**
 * Run artifacts come from git, not from the agent's word. After the doer stops
 * touching files we stage the worktree and read the real diff — the same evidence
 * the verifier and the human see. (§5 assemble→…→land; §6.1 evidence.)
 *
 * ASYNC by design: git spawns here are the hottest subprocess path in a run
 * (~120 ms for add + 2×diff); execSync would freeze the control plane's event loop
 * and serialize concurrent runs (measured ratio 1.0). execFile also avoids a shell.
 */

import { execFile } from "node:child_process";
import type { ActionRequest, RunArtifacts } from "../types.js";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** Stage everything and read the real diff + changed file list from git. */
export async function gitSnapshot(
  worktreeRoot: string,
  performed: ActionRequest[],
): Promise<RunArtifacts> {
  await git(worktreeRoot, ["add", "-A"]);
  const diff = await git(worktreeRoot, ["diff", "--cached"]);
  const names = (await git(worktreeRoot, ["diff", "--cached", "--name-only"])).trim();
  const filesChanged = names ? names.split("\n") : [];
  return {
    diff,
    filesChanged,
    // successCheck is run independently by the worker (§2.2) — placeholder here.
    successCheck: { exitCode: 0, stdout: "", stderr: "" },
    actions: performed,
  };
}

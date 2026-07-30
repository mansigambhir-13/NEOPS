/**
 * §2.2 — successCheck is run by a machine NEOP controls, not the agent.
 *
 * The run's status comes from THIS command's exit code, never from the agent's claim
 * of completion. Keeping it a separate injected runner means the agent's session
 * cannot fabricate a green result: the lifecycle runs it independently, in the
 * worktree, after the agent has stopped touching files.
 */

import { execSync } from "node:child_process";

export interface CheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SuccessCheckRunner {
  run(command: string, cwd: string): CheckResult;
}

/** Runs the check as a real subprocess with a hard timeout (§6.6). */
export class ShellSuccessCheckRunner implements SuccessCheckRunner {
  constructor(private readonly timeoutMs = 120_000) {}

  run(command: string, cwd: string): CheckResult {
    try {
      const stdout = execSync(command, {
        cwd,
        timeout: this.timeoutMs,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string };
      return {
        exitCode: typeof err.status === "number" ? err.status : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? (err.signal ? `killed by ${err.signal} (timeout?)` : "check failed"),
      };
    }
  }
}

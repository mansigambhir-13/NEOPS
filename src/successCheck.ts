/**
 * §2.2 — successCheck is run by a machine NEOP controls, not the agent.
 *
 * The run's status comes from THIS command's exit code, never from the agent's claim
 * of completion. Keeping it a separate injected runner means the agent's session
 * cannot fabricate a green result: the worker runs it independently, in the
 * worktree, after the agent has stopped touching files.
 *
 * ASYNC by design: a synchronous subprocess here blocks the whole Node event loop —
 * in the control plane that would serialize every concurrent run and stall every
 * HTTP request behind one shell check (measured: ~240 ms stalls). The interface
 * accepts a sync return too so tests can stub it with a plain object.
 */

import { exec } from "node:child_process";

export interface CheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SuccessCheckRunner {
  run(command: string, cwd: string): CheckResult | Promise<CheckResult>;
}

/** Runs the check as a real subprocess with a hard timeout (§6.6), off the event loop. */
export class ShellSuccessCheckRunner implements SuccessCheckRunner {
  constructor(private readonly timeoutMs = 120_000) {}

  run(command: string, cwd: string): Promise<CheckResult> {
    return new Promise((resolve) => {
      exec(
        command,
        { cwd, timeout: this.timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return resolve({ exitCode: 0, stdout, stderr });
          const e = err as { code?: number; signal?: string };
          resolve({
            exitCode: typeof e.code === "number" ? e.code : 1,
            stdout: stdout ?? "",
            stderr: stderr || (e.signal ? `killed by ${e.signal} (timeout?)` : "check failed"),
          });
        },
      );
    });
  }
}

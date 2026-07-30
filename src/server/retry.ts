/**
 * §6.3 retry policy — the plan's words, as code:
 *
 *   - TRANSIENT (network, 5xx, rate limit): retry same, exponential backoff, max 3.
 *   - TASK FAILURE (successCheck red): retry ONCE, with the failure output injected
 *     and an instruction to diagnose before acting. Different context, not the
 *     same roll of the dice.
 *   - VERIFIER VETO: do NOT auto-retry. Escalate. The agent and the check disagree
 *     about reality, and a human should look.
 *
 * Everything else (landed, awaiting_human, dropped, static vetoes) never retries.
 */

import type { RunOutcome } from "../pi/worker.js";

export type RetryKind = "transient" | "task_failure" | "none";

const TRANSIENT =
  /network|econn|etimedout|enotfound|eai_again|fetch failed|socket|5\d\d|rate.?limit|overloaded|timeout|temporar/i;

export function classifyForRetry(outcome: RunOutcome): RetryKind {
  if (outcome.status === "quarantined" && outcome.reason && TRANSIENT.test(outcome.reason)) {
    return "transient";
  }
  if (
    outcome.status === "escalated" &&
    outcome.verdict?.reasons.some((r) => r.startsWith("successCheck exited"))
  ) {
    // the check failed BEFORE the cold model was even consulted — a task failure,
    // not a verifier judgment. A genuine model veto never lands in this branch.
    return "task_failure";
  }
  return "none";
}

export interface AttemptMods {
  /** set on the single task-failure retry: the previous check's output, verbatim. */
  injectedFailure?: string;
}

export interface RetryOptions {
  maxTransient?: number; // total transient attempts (default 3)
  baseDelayMs?: number; // backoff base (default 1000; tests use ~1)
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (kind: Exclude<RetryKind, "none">, attempt: number, reason: string) => void;
}

export interface RetryResult {
  outcome: RunOutcome;
  attempts: number;
}

/** The §6.3 loop around one run attempt. */
export async function runWithRetry(
  attempt: (mods: AttemptMods) => Promise<RunOutcome>,
  opts: RetryOptions = {},
): Promise<RetryResult> {
  const maxTransient = opts.maxTransient ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let transientTries = 0;
  let taskRetried = false;
  let mods: AttemptMods = {};
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const outcome = await attempt(mods);
    const kind = classifyForRetry(outcome);

    if (kind === "transient" && transientTries < maxTransient - 1) {
      transientTries += 1;
      opts.onRetry?.("transient", attempts, outcome.reason ?? "transient failure");
      await sleep(base * 2 ** (transientTries - 1));
      continue; // same context — the failure was the world's, not the reasoning's
    }

    if (kind === "task_failure" && !taskRetried) {
      taskRetried = true;
      const detail = outcome.checkOutput
        ? `exit ${outcome.checkOutput.exitCode}\nstdout:\n${outcome.checkOutput.stdout}\nstderr:\n${outcome.checkOutput.stderr}`
        : (outcome.verdict?.reasons.join("; ") ?? "successCheck failed");
      opts.onRetry?.("task_failure", attempts, detail.slice(0, 200));
      mods = {
        injectedFailure:
          `A previous attempt at this exact task FAILED its successCheck. ` +
          `Diagnose the cause from the output below BEFORE acting — do not repeat the same approach.\n\n${detail.slice(0, 3000)}`,
      };
      continue; // different context — §6.3's whole point
    }

    return { outcome, attempts };
  }
}

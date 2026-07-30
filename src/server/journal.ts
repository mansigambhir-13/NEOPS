/**
 * Append-only JSONL journal — the control plane's persistence (§4 philosophy: the
 * write path is a log, state is a replay).
 *
 * Why a journal and not a database at V1: zero deps, crash-safe by construction
 * (a torn final line is skipped on replay), human-inspectable with `tail`, and the
 * event shapes map 1:1 onto the Supabase tables of the later phase.
 *
 * What MUST survive a restart, in order of importance:
 *   1. approvals + their CONSUMED state — losing consumption re-enables duplicate
 *      irreversible actions (§6.2); losing the approval loses a human decision.
 *   2. parked runs + their RunInput — an approval with nothing to resume is useless.
 *   3. the run ledger — verdicts and audit events are the operator's memory.
 *   4. chats — cheap, so why not.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Approval } from "../types.js";
import type { RunInput } from "../pi/worker.js";
import type { RunRecord } from "./store.js";

/** A run record with only serializable fields (RunRecord is already plain data). */
export type PersistedRun = Omit<RunRecord, never>;

export type JournalEvent =
  | { t: "run"; record: PersistedRun } // upsert — last write wins on replay
  | { t: "approval"; approval: Approval }
  | { t: "approval_consumed"; actionKey: string; at: string }
  | { t: "resumable"; runId: string; input: RunInput }
  | { t: "unresumable"; runId: string }
  | { t: "chat"; chatId: string; msg: { who: string; at: string; text: string; log?: string } };

export class Journal {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Append one event. Failures are swallowed after counting — persistence must
   * never flip an already-made decision (same rule as the audit sink). */
  private _failures = 0;
  append(event: JournalEvent): void {
    try {
      appendFileSync(this.path, JSON.stringify(event) + "\n", "utf8");
    } catch {
      this._failures += 1;
    }
  }
  get failures(): number {
    return this._failures;
  }

  /** Replay all events. A corrupt (torn) line is skipped, not fatal. */
  replay(): JournalEvent[] {
    if (!existsSync(this.path)) return [];
    const out: JournalEvent[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as JournalEvent);
      } catch {
        // torn tail from a crash mid-append — ignore
      }
    }
    return out;
  }
}

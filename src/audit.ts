/**
 * §4 Append-only audit trail.
 *
 * Every tool call, gate decision, and verdict lands here as one JSONL line, joinable
 * to the pi transcript by run_id. Two rules from §8.3 / §6:
 *   - append-only: we never rewrite a line.
 *   - a write failure must NEVER flip an already-decided verdict. The audit sink
 *     records failures but the caller's decision stands; audit is a witness, not a
 *     gatekeeper.
 *
 * The interface is sync-friendly and pluggable so the control plane can index into
 * Supabase while the transcript of record stays in pi's JSONL (§4).
 */

import { appendFileSync } from "node:fs";
import type { ActionRequest, GateDecision, Verdict } from "./types.js";

export type AuditEvent =
  | { type: "run_admitted"; runId: string; taskId: string; ts: string }
  | { type: "run_dropped"; runId: string; taskId: string; reason: string; ts: string }
  | { type: "action"; runId: string; action: ActionRequest; decision: GateDecision; ts: string }
  | { type: "human_blocked"; runId: string; actionKey: string; class: string; ts: string }
  | { type: "success_check"; runId: string; exitCode: number; ts: string }
  | { type: "verdict"; runId: string; verdict: Verdict; ts: string }
  | { type: "landed"; runId: string; ref: string; ts: string }
  | { type: "quarantined"; runId: string; reason: string; ts: string }
  | { type: "ceiling_breach"; runId: string; kind: string; ts: string }
  | { type: "broker"; runId: string; tool: string; ok: boolean; detail: string; ts: string }
  | { type: "retry"; runId: string; attempt: number; kind: "transient" | "task_failure"; reason: string; ts: string };

export interface AuditSink {
  write(event: AuditEvent): void;
  /** Non-fatal write failures, exposed for observability. Never throws. */
  readonly failures: number;
}

/** JSONL file sink. Swallows write errors (records them) — never throws to caller. */
export class JsonlAuditSink implements AuditSink {
  private _failures = 0;

  constructor(private readonly path: string) {}

  write(event: AuditEvent): void {
    try {
      appendFileSync(this.path, JSON.stringify(event) + "\n", { encoding: "utf8" });
    } catch {
      // §8.3: an audit-write failure must never flip a decided verdict. Count and move on.
      this._failures += 1;
    }
  }

  get failures(): number {
    return this._failures;
  }
}

/** In-memory sink for tests and dry runs. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  readonly failures = 0;

  write(event: AuditEvent): void {
    this.events.push(event);
  }
}

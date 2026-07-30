/**
 * Control-plane state: the run ledger and the approval store.
 *
 * In-memory at V1 (the plan's Supabase index is a later phase) — but the shapes are
 * the wire contract the console consumes, so they live here, not in the HTTP layer.
 * The ledger learns everything it knows from the worker's own audit events (a tee
 * sink), never from a parallel bookkeeping path that could drift.
 */

import type { AuditEvent, AuditSink } from "../audit.js";
import type { ActionRequest, Approval, Usage } from "../types.js";
import type { RunOutcome } from "../pi/worker.js";
import type { ApprovalStore } from "../pi/worker.js";
import type { TaskContract } from "../taskSchema.js";

/** One run as the control plane tracks it. */
export interface RunRecord {
  runId: string;
  task: TaskContract;
  startedAt: string; // ISO
  endedAt?: string;
  outcome?: RunOutcome;
  usage?: Usage;
  /** tool → count, aggregated from audit "action" events that were allowed. */
  actionCounts: Record<string, number>;
  /** set when the worker parks: the key the approval must be filed under. */
  pendingActionKey?: string;
  pendingAction?: ActionRequest;
  /** operator's decision, once made (drives "declined" display + resume). */
  decision?: Approval;
  events: AuditEvent[];
}

/** Audit sink that both forwards to an inner sink and folds events into the ledger. */
export class LedgerAuditSink implements AuditSink {
  constructor(
    private readonly record: RunRecord,
    private readonly inner?: AuditSink,
  ) {}

  write(event: AuditEvent): void {
    this.inner?.write(event);
    this.record.events.push(event);
    if (event.type === "action" && event.decision.verdict === "allow") {
      const t = event.action.tool;
      this.record.actionCounts[t] = (this.record.actionCounts[t] ?? 0) + 1;
    }
    if (event.type === "human_blocked") {
      this.record.pendingActionKey = event.actionKey;
    }
  }

  get failures(): number {
    return this.inner?.failures ?? 0;
  }
}

/** Idempotent in-memory approvals (§6.2): first decision wins, repeats return it. */
export class MemoryApprovalStore implements ApprovalStore {
  private readonly byKey = new Map<string, Approval>();

  find(actionKey: string): Approval | null {
    return this.byKey.get(actionKey) ?? null;
  }

  /** Returns the stored approval — the existing one if the key was already decided. */
  file(approval: Approval): Approval {
    const existing = this.byKey.get(approval.actionKey);
    if (existing) return existing;
    this.byKey.set(approval.actionKey, approval);
    return approval;
  }

  /** §6.2 single-use (replay path): re-apply a journaled consumption. */
  consume(actionKey: string, at: string): void {
    const a = this.byKey.get(actionKey);
    if (a && !a.consumedAt) a.consumedAt = at;
  }

  /**
   * §6.2 single-use (execution path): atomic check-and-consume, called by the
   * BROKER at the point of no return. Returns false if already consumed — the
   * caller must refuse as a duplicate. Atomic by construction in-process; the
   * Supabase phase makes it a conditional UPDATE.
   */
  consumeIfUnconsumed(actionKey: string, at: string): boolean {
    const a = this.byKey.get(actionKey);
    if (!a || a.consumedAt) return false;
    a.consumedAt = at;
    return true;
  }
}

/** The ledger: ordered run records, newest first for the console. */
export class RunLedger {
  private readonly runs = new Map<string, RunRecord>();

  open(runId: string, task: TaskContract, startedAt: string): RunRecord {
    const rec: RunRecord = { runId, task, startedAt, actionCounts: {}, events: [] };
    this.runs.set(runId, rec);
    return rec;
  }

  /** Journal-replay upsert: install a fully-formed record (last write wins). */
  put(record: RunRecord): void {
    this.runs.set(record.runId, record);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  close(runId: string, outcome: RunOutcome, endedAt: string): void {
    const rec = this.runs.get(runId);
    if (!rec) return;
    rec.outcome = outcome;
    rec.endedAt = endedAt;
    if (outcome.usage) rec.usage = outcome.usage;
    if (outcome.status !== "awaiting_human") {
      rec.pendingAction = undefined;
      rec.pendingActionKey = undefined;
    } else {
      rec.pendingAction = outcome.pendingAction;
    }
  }

  /** Newest first. */
  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
}

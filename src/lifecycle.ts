/**
 * §5 Run lifecycle: admit → isolate → assemble → execute → gate → verify → land → close.
 *
 * This orchestrator wires the invariants together. It owns no policy of its own —
 * every decision is delegated to policy.ts (gate), verify.ts (verifier), and
 * ceilings.ts (budget). Its job is sequencing and honouring their verdicts:
 *   - the gate says block_for_human  → the run parks at awaiting_human
 *   - the verifier vetoes            → quarantine + escalate (no auto-retry, §6.3)
 *   - a ceiling breaches             → steer to stop, then close
 *
 * Isolation (git worktree), the credential broker, digest batching, and the circuit
 * breaker live in the control plane; this module exposes the seams they attach to
 * (AdmissionCheck, ApprovalStore) but keeps the worker pure and testable.
 */

import type { ActionRequest, Approval, RunStatus, Verdict } from "./types.js";
import type { TaskContract } from "./taskSchema.js";
import type { AgentRuntime, ActionRuling } from "./runtime/AgentRuntime.js";
import { gate, actionKey, type GateContext } from "./policy.js";
import { CeilingTracker, resolveCeilings, type CeilingConfig } from "./ceilings.js";
import { verify, type VerifyConfig } from "./verify.js";
import type { AuditSink } from "./audit.js";
import type { SuccessCheckRunner } from "./successCheck.js";

/** A monotonic clock, injected so tests are deterministic (no Date.now in core). */
export type Clock = () => number;

/** Admission control (§5 step 1): breaker closed? scope free? cap intact? */
export interface AdmissionCheck {
  admit(task: TaskContract, runId: string): { ok: true } | { ok: false; reason: string };
}

/** Where human approvals for blocked actions are read from (§5 step 5, §8.2). */
export interface ApprovalStore {
  /** Look up an approval by idempotency key. Returns null if none yet. */
  find(actionKey: string): Approval | null;
}

export interface RunInput {
  runId: string;
  task: TaskContract;
  /** Absolute path of the isolated git worktree (§5 step 2). */
  worktreeRoot: string;
  /** Hosts this run may reach. */
  egressAllowlist: string[];
  /** Logical date for idempotency keying (§6.2), e.g. "2026-07-30". */
  logicalDate: string;
  /** Model ids for working turn vs verification (§7.4). */
  models: { work: string; verify: string };
  /** Scope-relative expected paths for the verifier's out-of-scope check. */
  expectedPaths?: string[];
  allowTestChanges?: boolean;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  verdict?: Verdict;
  pendingAction?: ActionRequest;
  reason?: string;
}

export interface LifecycleDeps {
  runtime: AgentRuntime;
  audit: AuditSink;
  admission: AdmissionCheck;
  approvals: ApprovalStore;
  clock: Clock;
  ceilings?: Partial<CeilingConfig>;
  /**
   * §2.2 — if provided, the lifecycle runs successCheck ITSELF (in the worktree) and
   * uses its exit code as authoritative, ignoring whatever the agent's session
   * claimed. Omit only in unit tests that pre-bake the result in artifacts.
   */
  successCheckRunner?: SuccessCheckRunner;
}

/** Stable content hash for idempotency keys, no crypto dep needed. */
function contentHash(action: ActionRequest): string {
  const s = JSON.stringify({ t: action.tool, a: action.args ?? null });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

/**
 * Execute one run through the lifecycle. Returns a terminal-ish outcome; a
 * `awaiting_human` outcome is resumed by re-invoking once the approval exists.
 */
export async function runLifecycle(input: RunInput, deps: LifecycleDeps): Promise<RunOutcome> {
  const { runId, task } = input;
  const now = deps.clock;
  const ts = () => new Date(now()).toISOString();

  // 1. ADMIT
  const admit = deps.admission.admit(task, runId);
  if (!admit.ok) {
    deps.audit.write({ type: "run_dropped", runId, taskId: task.id, reason: admit.reason, ts: ts() });
    return { runId, status: "dropped", reason: admit.reason };
  }
  deps.audit.write({ type: "run_admitted", runId, taskId: task.id, ts: ts() });

  const cfg = resolveCeilings({ ...task.ceilings, ...deps.ceilings });
  const tracker = new CeilingTracker(cfg, now());
  const gateCtx: GateContext = {
    worktreeRoot: input.worktreeRoot,
    egressAllowlist: input.egressAllowlist,
  };

  let ceilingHit: string | null = null;

  // 3+4+5. ASSEMBLE + EXECUTE + GATE (gate runs inline per action via onAction)
  const session = await deps.runtime.runSession({
    runId,
    systemPrompt: task.systemPrompt,
    tools: task.tools.map((t) => t.name),
    cwd: input.worktreeRoot,
    model: input.models.work,
    onTurn: () => {
      const breach = tracker.admitTurn(now());
      if (breach) {
        ceilingHit = breach.kind;
        return { steer: "You are at a budget ceiling. Summarise progress and stop — do not start new edits." };
      }
      return;
    },
    onAction: (action): ActionRuling => {
      // ceiling check before the action executes (§2.3 — before spend)
      const breach = tracker.admitAction(now());
      if (breach) {
        ceilingHit = breach.kind;
        deps.audit.write({ type: "ceiling_breach", runId, kind: breach.kind, ts: ts() });
        return { allow: false, block: false, reason: `ceiling:${breach.kind}` };
      }

      // resolve the tool's class from the task binding (authoritative), not the agent
      const binding = task.tools.find((t) => t.name === action.tool);
      const withClass: ActionRequest = { ...action, declaredClass: binding?.class ?? "unknown" };

      const decision = gate(withClass, gateCtx);
      deps.audit.write({ type: "action", runId, action: withClass, decision, ts: ts() });

      if (decision.verdict === "allow") return { allow: true };

      if (decision.verdict === "deny") {
        return { allow: false, block: false, reason: decision.reason };
      }

      // block_for_human: has a human already approved THIS action (idempotency)?
      const key = actionKey(task.id, input.logicalDate, contentHash(withClass));
      const approval = deps.approvals.find(key);
      if (approval?.decision === "approve") {
        // The action tool re-checks the approval independently (§5 step 5) — here the
        // gate honours it. The broker enforces single-use of the key downstream.
        return { allow: true };
      }
      deps.audit.write({ type: "human_blocked", runId, actionKey: key, class: decision.class, ts: ts() });
      return { allow: false, block: true, reason: decision.reason };
    },
  });

  tracker.record(session.usage);

  if (session.stopReason === "blocked_for_human") {
    return {
      runId,
      status: "awaiting_human",
      pendingAction: session.pendingAction,
      reason: "irreversible action requires approval",
    };
  }

  if (session.stopReason === "error") {
    deps.audit.write({ type: "quarantined", runId, reason: session.error ?? "runtime error", ts: ts() });
    return { runId, status: "quarantined", reason: session.error ?? "runtime error" };
  }

  // 6. VERIFY — run successCheck independently (§2.2), then the verifier vetoes.
  // Authority for "done" is this machine run, NEVER the agent's session artifact.
  const checkResult = deps.successCheckRunner
    ? deps.successCheckRunner.run(task.successCheck, input.worktreeRoot)
    : session.artifacts.successCheck;
  const artifactsToVerify = { ...session.artifacts, successCheck: checkResult };

  deps.audit.write({
    type: "success_check",
    runId,
    exitCode: checkResult.exitCode,
    ts: ts(),
  });

  const vcfg: VerifyConfig = {
    runId,
    model: input.models.verify,
    ...(input.expectedPaths !== undefined ? { expectedPaths: input.expectedPaths } : {}),
    ...(input.allowTestChanges !== undefined ? { allowTestChanges: input.allowTestChanges } : {}),
  };
  const verdict = await verify(deps.runtime, artifactsToVerify, task, vcfg);
  deps.audit.write({ type: "verdict", runId, verdict, ts: ts() });

  if (!verdict.pass) {
    // §6.3: verifier veto does NOT auto-retry. Quarantine + escalate.
    deps.audit.write({ type: "quarantined", runId, reason: "verifier veto", ts: ts() });
    return { runId, status: "escalated", verdict, reason: "verifier veto" };
  }

  if (ceilingHit) {
    // Verified work but we stopped on a ceiling — land what we have, flag it.
    deps.audit.write({ type: "landed", runId, ref: "partial", ts: ts() });
    return { runId, status: "landed", verdict, reason: `landed after ceiling:${ceilingHit}` };
  }

  // 7. LAND
  deps.audit.write({ type: "landed", runId, ref: "ok", ts: ts() });
  return { runId, status: "landed", verdict };
}

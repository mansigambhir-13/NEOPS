/**
 * The NEOP worker, built directly on pi-agent-core's `Agent`.
 *
 * §5 lifecycle: admit → isolate → assemble → execute → gate → verify → land → close.
 *
 * The three invariants attach to pi's real seams — there is no adapter indirection:
 *   - the reversibility gate + standing denials run in `Agent.beforeToolCall`,
 *     which sees every intended tool call before it executes and can BLOCK it;
 *   - ceilings are enforced by counting `turn_end` events (and per-action, before
 *     spend, inside the gate hook) and calling `agent.abort()` on breach;
 *   - "done" comes from an independent `successCheck` run in the worktree, never
 *     from the agent's claim; and a cold, tool-less verifier vetoes the result.
 *
 * The engine owns no policy of its own — it delegates to policy.ts (gate),
 * verify.ts (verifier), and ceilings.ts (budget), and honours their verdicts.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { Usage as PiUsage } from "@earendil-works/pi-ai";

import type { ActionRequest, Approval, RunArtifacts, RunStatus, Usage, Verdict } from "../types.js";
import type { TaskContract } from "../taskSchema.js";
import { gate, actionKey, type GateContext } from "../policy.js";
import { CeilingTracker, resolveCeilings, type CeilingConfig } from "../ceilings.js";
import { makeColdVerifier, verify, type VerifyConfig } from "../verify.js";
import type { AuditSink } from "../audit.js";
import type { SuccessCheckRunner } from "../successCheck.js";
import type { ResolvedModels } from "./provider.js";
import { makeToolContext } from "./env.js";
import { makeTools, toActionRequest } from "./tools.js";
import { gitSnapshot } from "./snapshot.js";

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
  /** §6.2 single-use: mark an approval consumed at the moment the gate honours it. */
  consume?(actionKey: string, at: string): void;
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
  /** Scope-relative expected paths for the verifier's out-of-scope check. */
  expectedPaths?: string[];
  allowTestChanges?: boolean;
  /** QB3 tenancy: confine reads to the worktree (see GateContext.readJail). */
  readJail?: boolean;
  /** QB3: additionally confine writes to these dirs (Foreman scope). */
  writeAllowDirs?: string[];
  /** QB3: deny writes inside these dirs (ground-truth/). */
  writeDenyDirs?: string[];
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  verdict?: Verdict;
  pendingAction?: ActionRequest;
  reason?: string;
  usage?: Usage;
}

export interface WorkerDeps {
  /** Resolved pi-ai models + the StreamFn bridge (from buildModels or the faux provider). */
  models: ResolvedModels;
  audit: AuditSink;
  admission: AdmissionCheck;
  approvals: ApprovalStore;
  clock: Clock;
  successCheck: SuccessCheckRunner;
  ceilings?: Partial<CeilingConfig>;
  /** Override the tool execution context (tests). Default: worktree-scoped Node env. */
  makeToolContext?: (worktreeRoot: string) => ExecutionToolContext;
  /**
   * Override tool construction (Quick Build: registry-bound tools with their own
   * names/impls). Default: the built-in NEOP tool registry.
   */
  makeTools?: (names: string[], ctx: ExecutionToolContext) => import("@earendil-works/pi-agent-core").AgentTool[];
  /** Override artifact snapshotting (tests). Default: real git diff. */
  snapshot?: (worktreeRoot: string, performed: ActionRequest[]) => RunArtifacts | Promise<RunArtifacts>;
}

/** Stable content hash for idempotency keys, no crypto dep needed. */
function contentHash(action: ActionRequest): string {
  const s = JSON.stringify({ t: action.tool, a: action.args ?? null });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

/** pi-ai Usage → NEOP Usage (turns are counted by the caller). */
function foldUsage(acc: Usage, pi: PiUsage): Usage {
  return {
    inputTokens: acc.inputTokens + pi.input,
    outputTokens: acc.outputTokens + pi.output,
    costUsd: acc.costUsd + pi.cost.total,
    turns: acc.turns + 1,
  };
}

/**
 * Execute one run through the lifecycle. Returns a terminal-ish outcome; an
 * `awaiting_human` outcome is resumed by re-invoking once the approval exists.
 */
export async function runWorker(input: RunInput, deps: WorkerDeps): Promise<RunOutcome> {
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
    ...(input.readJail !== undefined ? { readJail: input.readJail } : {}),
    ...(input.writeAllowDirs ? { writeAllowDirs: input.writeAllowDirs } : {}),
    ...(input.writeDenyDirs ? { writeDenyDirs: input.writeDenyDirs } : {}),
  };

  // 2+3. ISOLATE + ASSEMBLE — tools scoped to the worktree; nothing inherited.
  const toolCtx = (deps.makeToolContext ?? makeToolContext)(input.worktreeRoot);
  const tools = (deps.makeTools ?? makeTools)(
    task.tools.map((t) => t.name),
    toolCtx,
  );

  // Run-scoped mutable state the hooks close over.
  const performed: ActionRequest[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, turns: 0, costUsd: 0 };
  let ceilingHit: string | null = null;
  let pendingAction: ActionRequest | undefined;
  let runError: string | undefined;

  // 4+5. EXECUTE + GATE — the gate runs inline per tool call via beforeToolCall.
  const gateHook = async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const binding = task.tools.find((t) => t.name === ctx.toolCall.name);
    const cls = binding?.class ?? "unknown";
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const action = toActionRequest(ctx.toolCall.name, args, cls, input.worktreeRoot);

    // ceiling check BEFORE the action executes (§2.3 — before spend)
    const breach = tracker.admitAction(now());
    if (breach) {
      ceilingHit = breach.kind;
      deps.audit.write({ type: "ceiling_breach", runId, kind: breach.kind, ts: ts() });
      agent.abort();
      return { block: true, reason: `ceiling:${breach.kind}` };
    }

    const decision = gate(action, gateCtx);
    deps.audit.write({ type: "action", runId, action, decision, ts: ts() });

    if (decision.verdict === "allow") {
      performed.push(action);
      return undefined; // allow
    }

    if (decision.verdict === "deny") {
      // Hard deny: the agent is told and may adapt; the run continues.
      return { block: true, reason: decision.reason };
    }

    // block_for_human: has a human already approved THIS action (idempotency §6.2)?
    const key = actionKey(task.id, input.logicalDate, contentHash(action));
    const approval = deps.approvals.find(key);
    if (approval?.decision === "approve") {
      if (approval.consumedAt) {
        // §6.2: the broker REJECTS a repeat key — this exact irreversible action
        // already happened once today. Never silently repeat it.
        deps.audit.write({ type: "action", runId, action, decision: { verdict: "deny", class: decision.class, reason: `duplicate irreversible action — idempotency key already consumed (${key})` }, ts: ts() });
        return { block: true, reason: `duplicate irreversible action denied: ${key} was already used at ${approval.consumedAt}` };
      }
      deps.approvals.consume?.(key, ts());
      performed.push(action);
      return undefined; // honour the approval — exactly once
    }
    deps.audit.write({ type: "human_blocked", runId, actionKey: key, class: decision.class, ts: ts() });
    pendingAction = action;
    agent.abort();
    return { block: true, reason: decision.reason };
  };

  const agent = new Agent({
    initialState: { systemPrompt: task.systemPrompt, model: deps.models.work, tools },
    streamFn: deps.models.streamFn,
    beforeToolCall: gateHook,
  });

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type !== "turn_end") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    usage = foldUsage(usage, message.usage);
    tracker.record(usage);
    const breach = tracker.admitTurn(now());
    if (breach) {
      ceilingHit = breach.kind;
      deps.audit.write({ type: "ceiling_breach", runId, kind: breach.kind, ts: ts() });
      agent.abort();
    }
  });

  try {
    await agent.prompt(task.description);
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  } finally {
    unsubscribe();
  }

  // A parked irreversible action wins over everything else — resume needs the action.
  if (pendingAction) {
    return {
      runId,
      status: "awaiting_human",
      pendingAction,
      reason: "irreversible action requires approval",
      usage,
    };
  }

  const lastError = agent.state.errorMessage;
  if (!ceilingHit && (runError || lastError)) {
    const reason = runError ?? lastError ?? "runtime error";
    deps.audit.write({ type: "quarantined", runId, reason, ts: ts() });
    return { runId, status: "quarantined", reason, usage };
  }

  // 6. VERIFY — run successCheck independently (§2.2), then the verifier vetoes.
  // Authority for "done" is this machine run, NEVER the agent's session artifact.
  const snapshot = deps.snapshot ?? gitSnapshot;
  const artifacts = await snapshot(input.worktreeRoot, performed);
  const checkResult = await deps.successCheck.run(task.successCheck, input.worktreeRoot);
  const artifactsToVerify = { ...artifacts, successCheck: checkResult };

  deps.audit.write({ type: "success_check", runId, exitCode: checkResult.exitCode, ts: ts() });

  const vcfg: VerifyConfig = {
    runId,
    model: deps.models.verify.id,
    ...(input.expectedPaths !== undefined ? { expectedPaths: input.expectedPaths } : {}),
    ...(input.allowTestChanges !== undefined ? { allowTestChanges: input.allowTestChanges } : {}),
  };
  const cold = makeColdVerifier(deps.models.models, deps.models.verify);
  const verdict = await verify(cold, artifactsToVerify, task, vcfg);
  deps.audit.write({ type: "verdict", runId, verdict, ts: ts() });

  if (!verdict.pass) {
    // §6.3: verifier veto does NOT auto-retry. Quarantine + escalate.
    deps.audit.write({ type: "quarantined", runId, reason: "verifier veto", ts: ts() });
    return { runId, status: "escalated", verdict, reason: "verifier veto", usage };
  }

  if (ceilingHit) {
    // Verified work but we stopped on a ceiling — land what we have, flag it.
    deps.audit.write({ type: "landed", runId, ref: "partial", ts: ts() });
    return { runId, status: "landed", verdict, reason: `landed after ceiling:${ceilingHit}`, usage };
  }

  // 7. LAND
  deps.audit.write({ type: "landed", runId, ref: "ok", ts: ts() });
  return { runId, status: "landed", verdict, usage };
}

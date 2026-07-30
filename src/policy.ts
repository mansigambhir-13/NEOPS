/**
 * §2.1 Reversibility gate + §8.3 standing denials.
 *
 * This is the file the whole safety model rests on. Two rules dominate:
 *   1. Unknown action classes fail CLOSED — treated as irreversible.
 *   2. Standing denials are a non-overridable floor — no task YAML, no prompt,
 *      no approval can lift them. They are checked FIRST and hard-deny.
 *
 * The gate is pure and synchronous: given an ActionRequest it returns a
 * GateDecision. It never performs the action and never trusts the agent's claim
 * about its own action class — the class is resolved here, from the registry.
 */

import type { ActionClass, ActionRequest, GateDecision, Reversibility } from "./types.js";

/**
 * The single source of truth mapping action class → reversibility (§2.1).
 * Adding a tool means classifying it here. Anything absent resolves to `unknown`.
 */
const CLASS_REVERSIBILITY: Record<Exclude<ActionClass, "unknown">, Reversibility> = {
  read: "reversible",
  workspace_write: "reversible",
  internal_post: "reversible",
  pr_open: "reversible",
  test_run: "reversible",
  public_publish: "irreversible",
  external_email: "irreversible",
  spend: "irreversible",
  prod_write: "irreversible",
  pr_merge: "irreversible",
};

/**
 * Resolve an action's reversibility. Unknown / unclassified → irreversible.
 * This is invariant #1's fail-closed behaviour, in one function.
 */
export function reversibilityOf(cls: ActionClass): Reversibility {
  if (cls === "unknown") return "irreversible";
  return CLASS_REVERSIBILITY[cls] ?? "irreversible";
}

/**
 * §8.3 Standing denials — the non-overridable floor.
 *
 * Each rule inspects an ActionRequest and, if it matches, hard-denies. These are
 * enforced independent of action class or approval: a merge-to-main is denied even
 * if a human "approved" it, because the container must never be able to do it.
 */
export interface StandingDenial {
  id: string;
  reason: string;
  matches: (a: ActionRequest) => boolean;
}

/** Case-insensitive whole-argument scan helper. */
function argsInclude(a: ActionRequest, needle: RegExp): boolean {
  if (!a.args) return false;
  const blob = JSON.stringify(a.args).toLowerCase();
  return needle.test(blob);
}

export const DEFAULT_STANDING_DENIALS: StandingDenial[] = [
  {
    id: "no-force-push",
    reason: "force-push / history rewrite is never permitted",
    matches: (a) =>
      a.tool === "git" &&
      argsInclude(a, /(--force\b|--force-with-lease|\bpush\s+-f\b|filter-branch|reset\s+--hard\s+origin)/),
  },
  {
    id: "no-merge-main",
    reason: "merge to a protected branch is never done by the agent",
    matches: (a) =>
      a.declaredClass === "pr_merge" ||
      (a.tool === "git" && argsInclude(a, /\bmerge\b.*(main|master|prod|release)/)),
  },
  {
    id: "no-destructive-sql",
    reason: "DROP / TRUNCATE / unbounded DELETE are never permitted",
    matches: (a) =>
      argsInclude(a, /\b(drop\s+table|drop\s+database|truncate)\b/) ||
      // DELETE / UPDATE with no WHERE clause
      argsInclude(a, /\b(delete\s+from|update)\b(?![\s\S]*\bwhere\b)/),
  },
  {
    id: "no-secret-reads",
    reason: "reading secret files / env stores is never permitted",
    matches: (a) =>
      !!a.targetPath &&
      /(^|\/)(\.env(\.[a-z]+)?|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials|\.aws\/|\.ssh\/)/i.test(
        a.targetPath,
      ),
  },
];

/** Configuration the gate needs beyond the action itself. */
export interface GateContext {
  /** Absolute path of the run's git worktree. Writes must stay inside it. */
  worktreeRoot: string;
  /** Hosts the run is permitted to reach (egress allowlist). */
  egressAllowlist: string[];
  /** Standing denials in force (defaults to DEFAULT_STANDING_DENIALS). */
  standingDenials?: StandingDenial[];
  /**
   * Tenancy (Quick Build QB3): when true, READS are confined to the worktree too.
   * A git worktree is a convenience boundary, not a security one — without this,
   * an absolute-path read walks into a sibling worktree or another client's
   * ground-truth. Off by default (single-tenant runs read freely).
   */
  readJail?: boolean;
  /** If set, writes are additionally confined to these dirs (Foreman: registry/+neops/). */
  writeAllowDirs?: string[];
  /** Writes inside these dirs are denied even in-jail (ground-truth/ is agent-readable, agent-unwritable). */
  writeDenyDirs?: string[];
}

/** True if `child` is inside `root` (no escape via .. or symlink-looking paths). */
function isInside(root: string, child: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const r = norm(root);
  const c = norm(child);
  return c === r || c.startsWith(r + "/");
}

/**
 * The gate. Given an action and its context, decide allow / block_for_human / deny.
 *
 * Order matters:
 *   1. Standing denials (hard floor) — deny.
 *   2. Worktree jail for any write — deny on escape.
 *   3. Egress allowlist for any networked action — deny on non-allowlisted host.
 *   4. Reversibility — reversible allows, irreversible blocks for a human.
 */
export function gate(action: ActionRequest, ctx: GateContext): GateDecision {
  const cls: ActionClass = action.declaredClass ?? "unknown";
  const denials = ctx.standingDenials ?? DEFAULT_STANDING_DENIALS;

  // 1. Standing denials — non-overridable.
  for (const d of denials) {
    if (d.matches(action)) {
      return { verdict: "deny", class: cls, reason: `standing-denial:${d.id}: ${d.reason}` };
    }
  }

  // 2. Worktree jail — any write must stay inside the worktree (§8.3).
  const writesFile = cls === "workspace_write" || cls === "prod_write";
  if (action.targetPath && writesFile && !isInside(ctx.worktreeRoot, action.targetPath)) {
    return {
      verdict: "deny",
      class: cls,
      reason: `write outside worktree denied: ${action.targetPath}`,
    };
  }
  // 2b. Write allowlist (Foreman scope: registry/ + neops/, nothing else).
  if (
    action.targetPath &&
    writesFile &&
    ctx.writeAllowDirs?.length &&
    !ctx.writeAllowDirs.some((d) => isInside(d, action.targetPath!))
  ) {
    return {
      verdict: "deny",
      class: cls,
      reason: `write outside allowed dirs denied: ${action.targetPath}`,
    };
  }
  // 2c. Write-deny dirs — ground truth is agent-readable, agent-unwritable.
  if (action.targetPath && writesFile && ctx.writeDenyDirs?.some((d) => isInside(d, action.targetPath!))) {
    return {
      verdict: "deny",
      class: cls,
      reason: `write to protected dir denied (ground truth is not agent-writable): ${action.targetPath}`,
    };
  }
  // 2d. Read jail (tenancy): reads confined to the worktree when enabled.
  if (ctx.readJail && cls === "read" && action.targetPath && !isInside(ctx.worktreeRoot, action.targetPath)) {
    return {
      verdict: "deny",
      class: cls,
      reason: `read outside worktree denied (tenancy read-jail): ${action.targetPath}`,
    };
  }

  // 3. Egress allowlist — any networked action must target an allowlisted host.
  if (action.targetHost && !ctx.egressAllowlist.includes(action.targetHost)) {
    return {
      verdict: "deny",
      class: cls,
      reason: `egress to non-allowlisted host denied: ${action.targetHost}`,
    };
  }

  // 4. Reversibility gate (invariant #1). Unknown already resolves to irreversible.
  if (reversibilityOf(cls) === "irreversible") {
    return {
      verdict: "block_for_human",
      class: cls,
      reason:
        cls === "unknown"
          ? "unclassified action — failing closed, human decision required"
          : `irreversible action (${cls}) — human decision required`,
    };
  }

  return { verdict: "allow", class: cls };
}

/**
 * Idempotency key for an irreversible action (§6.2). Derived from stable inputs so a
 * retry of the same logical action collides and is rejected by the broker.
 */
export function actionKey(taskId: string, logicalDate: string, contentHash: string): string {
  return `${taskId}:${logicalDate}:${contentHash}`;
}

/**
 * Stable content hash over (tool, args) — the third component of the actionKey.
 * Lives here (not in the worker) because the GATE and the BROKER must derive the
 * IDENTICAL key from the identical action: the gate to park/honour, the broker to
 * re-check and consume at the point of no return. No crypto dep needed — this is
 * an idempotency discriminator, not a security primitive.
 */
export function contentHash(tool: string, args: Record<string, unknown> | undefined): string {
  const s = JSON.stringify({ t: tool, a: args ?? null });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

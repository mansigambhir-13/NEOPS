/* The seam between the control plane's wire JSON and the console's display model.
 *
 * The control plane (src/server/controlPlane.ts, `toWire`) emits per run:
 *   { runId, taskId, status, verdict?, startedAt (ISO), durationMs?, tokens,
 *     note, successCheck, actionCounts: {tool: n}, gate?: {cls, tool, actionKey} }
 * with worker RunStatus values:
 *   landed | escalated | quarantined | awaiting_human | running | admitted |
 *   verifying | dropped   (+ verdict override "declined" for operator denials)
 *
 * The console speaks: verified | vetoed | awaiting | failed | running | declined.
 * ALL shape absorption happens here (see web/RECONCILIATION.md) — the control
 * plane's JSON never reaches a component. The MockClient emits console-shaped
 * records directly; every mapping below falls back gracefully for those.
 */

/** @typedef {"verified"|"vetoed"|"awaiting"|"failed"|"running"|"declined"} ConsoleVerdict */

/**
 * @param {{status:string}} outcome
 * @returns {ConsoleVerdict}
 */
export function statusToVerdict(outcome) {
  switch (outcome.status) {
    case "landed":
      return "verified";
    case "escalated":
      // escalation is (today) always a verifier veto; a finer cause field can split
      // this later — see RECONCILIATION.md §1.
      return "vetoed";
    case "quarantined":
      return "failed";
    case "awaiting_human":
      return "awaiting";
    case "running":
    case "admitted":
    case "verifying":
      return "running";
    case "dropped":
    default:
      // an unmapped status must read red, never silently "verified"
      return "failed";
  }
}

/** ISO timestamp → the console's short "HH:MM" label. */
export function humanTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** milliseconds → "6m 12s" / "412ms". */
export function humanDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** integer tokens → "84.2k". */
export function humanTokens(n) {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** {tool: count} → ["edit_file ×2", ...] (the chip format). */
export function actionChips(counts) {
  return Object.entries(counts ?? {}).map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool));
}

/**
 * Human question + options per action class, for gates where the control plane
 * sends only the class (the worker parks a pendingAction, not prose). One place,
 * auditable. Approve-first matches the shipped design; the deny phrasing is what
 * `decisionFromOption` keys on.
 */
export const GATE_PROMPTS = {
  public_publish: { ask: "Publish this to a public surface?", opts: ["Publish it", "Hold, I'll review"] },
  external_email: { ask: "Send this email outside the org?", opts: ["Send it", "Don't send"] },
  spend: { ask: "Approve this spend?", opts: ["Approve the spend", "Don't spend"] },
  prod_write: { ask: "Write to production state?", opts: ["Apply it", "Don't touch prod"] },
  pr_merge: { ask: "Merge this PR?", opts: ["Merge it", "Hold the merge"] },
  unknown: { ask: "This action is unclassified — it fails closed. Allow it?", opts: ["Allow once", "Don't allow"] },
};

/** Wire gate → console gate ({cls, ask, opts}). Passes a full gate through untouched. */
export function toConsoleGate(gate) {
  if (!gate) return undefined;
  if (gate.ask && gate.opts) return gate; // mock / future rich payloads
  const p = GATE_PROMPTS[gate.cls] ?? GATE_PROMPTS.unknown;
  const tool = gate.tool ? ` (${gate.tool})` : "";
  return { cls: gate.cls, ask: p.ask.replace("?", `${tool}?`), opts: p.opts };
}

/**
 * Map a run record (wire or mock-shaped) onto the console's Run view-model.
 * @param {object} r
 */
export function toConsoleRun(r) {
  const gate = toConsoleGate(r.gate);
  return {
    id: r.runId ?? r.id,
    task: r.taskId ?? r.task,
    at: r.at ?? humanTime(r.startedAt),
    dur: r.dur ?? humanDuration(r.durationMs),
    tok: r.tok ?? (typeof r.tokens === "number" ? humanTokens(r.tokens) : "0"),
    verdict: r.verdict ?? statusToVerdict(r),
    note: r.note ?? (r.reasons ? r.reasons.join("; ") : ""),
    check: r.check ?? r.successCheck ?? "",
    actions: r.actions ?? actionChips(r.actionCounts),
    ...(gate ? { gate } : {}),
  };
}

/** Metrics: wire shape already matches the console; fill safe fallbacks. */
export function toConsoleMetrics(m) {
  return {
    contracts: m?.contracts ?? 0,
    scopes: m?.scopes ?? 0,
    spend: m?.spend ?? { used: "—", cap: "—" },
    vetoRate: m?.vetoRate ?? "—",
    interruptsToday: m?.interruptsToday ?? 0,
    breakers: m?.breakers ?? "—",
    ...(m?.mode ? { mode: m.mode } : {}),
  };
}

/* The seam between the worker core's domain and the console's display model.
 *
 * The worker (src/lifecycle.ts) produces a RunOutcome with a RunStatus:
 *   "landed" | "escalated" | "quarantined" | "awaiting_human" | "running" | "dropped"
 * and a Verdict { pass, reasons, outOfScope, testsTampered, secretsSuspected }.
 *
 * The console speaks a compact verdict vocabulary. This maps one to the other, so the
 * HttpClient can consume the real control-plane payload without the UI changing.
 * When the control plane ships, only this function needs to match its exact JSON.
 */

/** @typedef {"verified"|"vetoed"|"awaiting"|"failed"|"running"} ConsoleVerdict */

/**
 * @param {{status:string, verdict?:{pass?:boolean, testsTampered?:boolean, outOfScope?:boolean}}} outcome
 * @returns {ConsoleVerdict}
 */
export function statusToVerdict(outcome) {
  switch (outcome.status) {
    case "landed":
      return "verified";
    case "escalated":
      // an escalation caused by a verifier veto shows as "vetoed"; other escalations
      // still surface red — the console groups them under the veto glyph.
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
      return "failed";
  }
}

/**
 * Map a control-plane run record onto the console's Run view-model (the shape the
 * mock data uses). Fields the control plane doesn't send yet fall back gracefully.
 * @param {object} r control-plane run
 */
export function toConsoleRun(r) {
  return {
    id: r.runId ?? r.id,
    task: r.taskId ?? r.task,
    at: r.at ?? "",
    dur: r.durationHuman ?? r.dur ?? "—",
    tok: r.tokensHuman ?? r.tok ?? "0",
    verdict: r.verdict ?? statusToVerdict(r),
    note: r.note ?? (r.reasons ? r.reasons.join("; ") : ""),
    check: r.check ?? r.successCheck ?? "",
    actions: r.actions ?? [],
    ...(r.gate ? { gate: r.gate } : {}),
  };
}

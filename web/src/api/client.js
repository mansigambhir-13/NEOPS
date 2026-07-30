/* NeopClient — the single interface the console talks to.
 *
 * Two implementations behind one shape:
 *   MockClient  — in-memory, runs today with zero backend. Approvals mutate local state.
 *   HttpClient  — the finish target: the FastAPI control plane (§4/§5 of the plan).
 *
 * createClient() picks HttpClient when VITE_NEOP_API_BASE is set, else MockClient.
 * The component imports ONLY createClient — it never knows which one it got.
 *
 * Interface (all async):
 *   getBootstrap()                     -> { metrics, chats, runs, ticks }
 *   getThread(chatId)                  -> Message[]
 *   sendMessage(chatId, text)          -> Message   (the NEOP reply)
 *   decideGate(runId, gateClass, opt)  -> Approval  (idempotent)
 */

import { CHATS, THREADS, RUNS, TICKS, METRICS } from "./mockData.js";
import { toConsoleRun } from "./adapter.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowHM = () =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Approve vs deny is inferred from the option text; the option itself is the note. */
function decisionFromOption(opt) {
  return /don'?t|hold|no\b|cancel|skip/i.test(opt) ? "deny" : "approve";
}

/** idempotency key mirrors the worker's actionKey(runId, gate, ...) shape. */
function gateKey(runId, gateClass) {
  return `${runId}:${gateClass}`;
}

// ------------------------------------------------------------------ MockClient
export class MockClient {
  constructor() {
    this.threads = structuredClone(THREADS);
    this.approvals = new Map(); // gateKey -> Approval (idempotent)
  }

  async getBootstrap() {
    await wait(80);
    return {
      metrics: METRICS,
      chats: CHATS,
      runs: RUNS.map(toConsoleRun),
      ticks: TICKS,
    };
  }

  async getThread(chatId) {
    await wait(40);
    return this.threads[chatId] ?? [];
  }

  async sendMessage(chatId, text) {
    // The human message is appended optimistically by the UI; here we only produce
    // NEOP's reply, as the control plane's POST /neop/chat would.
    await wait(1000);
    const reply = {
      who: "neop",
      at: nowHM(),
      text: "Reading the run ledger for that. Point this pane at POST /neop/chat and it answers from the live transcripts.",
    };
    this.threads[chatId] = [...(this.threads[chatId] ?? []), reply];
    return reply;
  }

  async decideGate(runId, gateClass, option) {
    await wait(120);
    const key = gateKey(runId, gateClass);
    // idempotent: a repeat decision returns the first one (§6.2 in the worker).
    if (this.approvals.has(key)) return this.approvals.get(key);
    const approval = {
      runId,
      actionKey: key,
      decision: decisionFromOption(option),
      option,
      approvedBy: "operator",
      ts: new Date().toISOString(),
    };
    this.approvals.set(key, approval);
    return approval;
  }
}

// ------------------------------------------------------------------ HttpClient
export class HttpClient {
  constructor(base) {
    this.base = base.replace(/\/$/, "");
  }

  async #json(path, init) {
    const res = await fetch(this.base + path, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
    return res.json();
  }

  async getBootstrap() {
    // GET /runs returns the run ledger; metrics + chats come from their own routes.
    const [metrics, chats, runsRaw, ticks] = await Promise.all([
      this.#json("/metrics").catch(() => METRICS),
      this.#json("/chats").catch(() => CHATS),
      this.#json("/runs").catch(() => []),
      this.#json("/runs/timeline").catch(() => TICKS),
    ]);
    const runs = (Array.isArray(runsRaw) ? runsRaw : runsRaw.runs ?? []).map(toConsoleRun);
    return { metrics, chats, runs: runs.length ? runs : RUNS.map(toConsoleRun), ticks };
  }

  async getThread(chatId) {
    return this.#json(`/chats/${encodeURIComponent(chatId)}`).catch(() => []);
  }

  async sendMessage(chatId, text) {
    // POST /neop/chat  { chatId, text } -> { who:"neop", at, text, log? }
    return this.#json("/neop/chat", {
      method: "POST",
      body: JSON.stringify({ chatId, text }),
    });
  }

  async decideGate(runId, gateClass, option) {
    // POST /runs/:id/gates/:gate  { decision, note }  (idempotent server-side, §5)
    const decision = decisionFromOption(option);
    return this.#json(
      `/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateClass)}`,
      { method: "POST", body: JSON.stringify({ decision, note: option }) },
    );
  }
}

// ------------------------------------------------------------------ factory
export function createClient() {
  const base = import.meta.env?.VITE_NEOP_API_BASE;
  return base ? new HttpClient(base) : new MockClient();
}

export const IS_LIVE = Boolean(import.meta.env?.VITE_NEOP_API_BASE);

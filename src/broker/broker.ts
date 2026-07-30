/**
 * §8.2 The credential broker.
 *
 * The job/worker context NEVER holds a long-lived credential. An action tool holds
 * only a narrow client handle: it says "perform publish_post with these params for
 * this run", and THE BROKER — which lives with the control plane — does everything
 * that requires trust:
 *
 *   1. re-checks the approval independently (§5 step 5 — it does not trust that
 *      the agent asked; the gate's allow is advisory, this check is authoritative)
 *   2. consumes the single-use idempotency key ATOMICALLY, then performs —
 *      consume-then-perform gives at-most-once: a crash can burn a key, it can
 *      never double-send (§6.2's actual point)
 *   3. scans the output (§8.1 layer 4): placeholders and non-allowlisted URLs
 *      never leave the building
 *   4. resolves the secret per (owner, name) and calls the outside world itself
 *
 * Consequence (the plan's words): a compromised run yields no reusable credential.
 * The blast radius is one run's approved actions.
 *
 * Adapters:
 *   outbox   — keyless default: the action is recorded as a JSONL receipt on disk.
 *              Safe everywhere; the demo path; also the audit trail of near-misses.
 *   resend   — real email via api.resend.com (secret RESEND_API_KEY). Zero deps.
 *   webhook  — real publish via an operator-configured webhook (secret
 *              PUBLISH_WEBHOOK_URL [+ PUBLISH_WEBHOOK_TOKEN]) — the Zapier/Make/
 *              Buffer-style integration path. Zero deps.
 *
 * In-process today; the interface is HTTP-shaped so that when workers leave the
 * process (container-per-run), BrokerClient becomes a thin HTTP client unchanged.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Approval } from "../types.js";

// ---------------------------------------------------------------- secrets

/**
 * Per-owner secret resolution (Quick Build v3 §6): key on (owner, name), fall back
 * to the default owner. Sources: an optional JSON file (NEOP_SECRETS_FILE:
 * {"owner": {"NAME": "value"}}) overridden by env vars NEOP_SECRET_<OWNER>_<NAME>
 * (owner uppercased, dashes → underscores; owner "default" for the fallback).
 */
export class SecretStore {
  private readonly file: Record<string, Record<string, string>>;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    secretsFile?: string,
  ) {
    this.file = {};
    const path = secretsFile ?? env.NEOP_SECRETS_FILE;
    if (path && existsSync(path)) {
      try {
        this.file = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string>>;
      } catch {
        console.error(`[broker] NEOP_SECRETS_FILE at ${path} is not valid JSON — ignored`);
      }
    }
  }

  private envKey(owner: string, name: string): string {
    return `NEOP_SECRET_${owner.toUpperCase().replace(/-/g, "_")}_${name}`;
  }

  get(owner: string, name: string): string | undefined {
    return (
      this.env[this.envKey(owner, name)] ??
      this.file[owner]?.[name] ??
      this.env[this.envKey("default", name)] ??
      this.file["default"]?.[name]
    );
  }
}

// ---------------------------------------------------------------- adapters

export interface PerformRequest {
  owner: string;
  runId: string;
  taskId: string;
  tool: string;
  actionKey: string;
  params: Record<string, unknown>;
}

export interface AdapterResult {
  receipt: string;
  detail?: string;
}

export interface ActionAdapter {
  /** perform the real-world action. Throws with a clear reason on failure. */
  perform(req: PerformRequest, secrets: SecretStore, fetchFn: typeof fetch): Promise<AdapterResult>;
}

/** Keyless default: the action lands as a JSONL receipt — evidence, not effect. */
export class OutboxAdapter implements ActionAdapter {
  constructor(private readonly dir: string) {}

  async perform(req: PerformRequest): Promise<AdapterResult> {
    mkdirSync(this.dir, { recursive: true });
    const receipt = `outbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    appendFileSync(
      join(this.dir, `${req.tool}.jsonl`),
      JSON.stringify({ receipt, at: new Date().toISOString(), ...req }) + "\n",
      "utf8",
    );
    return { receipt, detail: `recorded to outbox (${req.tool}.jsonl) — no external effect` };
  }
}

/** Real email via Resend. Secret: RESEND_API_KEY. Params: {to, subject, body}. */
export class ResendEmailAdapter implements ActionAdapter {
  async perform(req: PerformRequest, secrets: SecretStore, fetchFn: typeof fetch): Promise<AdapterResult> {
    const key = secrets.get(req.owner, "RESEND_API_KEY");
    if (!key) throw new Error(`no RESEND_API_KEY secret for owner "${req.owner}" — set NEOP_SECRET_${req.owner.toUpperCase()}_RESEND_API_KEY`);
    const from = secrets.get(req.owner, "MAIL_FROM") ?? "neop@notifications.local";
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: String(req.params.to), subject: String(req.params.subject), text: String(req.params.body) }),
    });
    if (!res.ok) throw new Error(`resend refused: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
    const data = (await res.json()) as { id?: string };
    return { receipt: data.id ?? "sent", detail: `email sent via resend to ${String(req.params.to)}` };
  }
}

/** Real publish via an operator-configured webhook (Zapier/Make/Buffer-style). */
export class WebhookPublishAdapter implements ActionAdapter {
  async perform(req: PerformRequest, secrets: SecretStore, fetchFn: typeof fetch): Promise<AdapterResult> {
    const url = secrets.get(req.owner, "PUBLISH_WEBHOOK_URL");
    if (!url) throw new Error(`no PUBLISH_WEBHOOK_URL secret for owner "${req.owner}"`);
    const token = secrets.get(req.owner, "PUBLISH_WEBHOOK_TOKEN");
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ tool: req.tool, actionKey: req.actionKey, params: req.params, owner: req.owner }),
    });
    if (!res.ok) throw new Error(`webhook refused: ${res.status}`);
    return { receipt: `webhook-${res.status}`, detail: `posted to publish webhook` };
  }
}

// ---------------------------------------------------------------- output scan

/** §8.1 layer 4: nothing with a placeholder or an off-list URL leaves the building. */
export function scanOutput(params: Record<string, unknown>, urlAllowlist: string[]): string | null {
  const text = Object.values(params).filter((v) => typeof v === "string").join("\n");
  if (/\{\{|TODO|TKTK|FIXME|<placeholder>/i.test(text)) {
    return "placeholder in final copy ({{ / TODO / TKTK) — refuse to send unfinished content";
  }
  for (const m of text.matchAll(/https?:\/\/([^\s/"')>]+)/gi)) {
    const host = m[1]!.toLowerCase();
    if (!urlAllowlist.some((a) => host === a || host.endsWith(`.${a}`))) {
      return `URL host "${host}" is not on the allowlist — a link the operator never vetted does not ship`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- the broker

export interface BrokerDeps {
  /** approval lookup — the broker re-checks; it does not trust the gate's allow. */
  findApproval: (actionKey: string) => Approval | null;
  /** atomic single-use consumption; returns false when already consumed. */
  consume: (actionKey: string, at: string) => boolean;
  /** where outbox receipts live. */
  outboxDir: string;
  secrets?: SecretStore;
  /** adapter per tool; unlisted tools are refused (fail closed). */
  adapters?: Record<string, ActionAdapter>;
  urlAllowlist?: string[];
  fetchFn?: typeof fetch;
  /** audit hook — every broker decision is a row. */
  onEvent?: (e: { type: "broker_perform" | "broker_refuse"; req: PerformRequest; detail: string; at: string }) => void;
}

export type PerformOutcome =
  | { ok: true; receipt: string; detail: string }
  | { ok: false; refusal: string };

export class CredentialBroker {
  private readonly secrets: SecretStore;
  private readonly adapters: Record<string, ActionAdapter>;

  constructor(private readonly deps: BrokerDeps) {
    this.secrets = deps.secrets ?? new SecretStore();
    this.adapters = deps.adapters ?? defaultAdapters(deps.outboxDir);
  }

  /** Tools the broker can perform — the binder consults this. */
  supports(tool: string): boolean {
    return tool in this.adapters;
  }

  async perform(req: PerformRequest): Promise<PerformOutcome> {
    const at = new Date().toISOString();
    const refuse = (refusal: string): PerformOutcome => {
      this.deps.onEvent?.({ type: "broker_refuse", req, detail: refusal, at });
      return { ok: false, refusal };
    };

    const adapter = this.adapters[req.tool];
    if (!adapter) return refuse(`no adapter for "${req.tool}" — the broker fails closed`);

    // 1. independent approval re-check (§5): the agent's word counts for nothing here
    const approval = this.deps.findApproval(req.actionKey);
    if (!approval || approval.decision !== "approve") {
      return refuse(`no valid approval for ${req.actionKey} — the human never said yes to THIS content`);
    }

    // 2. §8.1 layer 4 output scan — before any consumption, so fixable copy
    //    doesn't burn its key (same content will re-scan identically anyway)
    const scan = scanOutput(req.params, this.deps.urlAllowlist ?? []);
    if (scan) return refuse(scan);

    // 3. atomic consume-then-perform: at-most-once. A crash after this line burns
    //    the key without the side effect — visible, recoverable, never a duplicate.
    if (!this.deps.consume(req.actionKey, at)) {
      return refuse(`idempotency key already used (${req.actionKey}) — this exact action already happened`);
    }

    try {
      const result = await adapter.perform(req, this.secrets, this.deps.fetchFn ?? fetch);
      this.deps.onEvent?.({ type: "broker_perform", req, detail: result.detail ?? result.receipt, at });
      return { ok: true, receipt: result.receipt, detail: result.detail ?? "" };
    } catch (e) {
      // key is burned (deliberately); the failure is loud and attributable
      const msg = `perform failed AFTER key consumption: ${(e as Error).message} — key ${req.actionKey} is burned; re-approve fresh content to retry`;
      this.deps.onEvent?.({ type: "broker_refuse", req, detail: msg, at });
      return { ok: false, refusal: msg };
    }
  }
}

/** Adapter selection per tool via env: outbox (default) | resend | webhook. */
export function defaultAdapters(outboxDir: string, env: Record<string, string | undefined> = process.env): Record<string, ActionAdapter> {
  const outbox = new OutboxAdapter(outboxDir);
  return {
    send_email: env.NEOP_ADAPTER_SEND_EMAIL === "resend" ? new ResendEmailAdapter() : outbox,
    publish_post: env.NEOP_ADAPTER_PUBLISH_POST === "webhook" ? new WebhookPublishAdapter() : outbox,
  };
}

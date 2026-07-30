/**
 * §8.2 credential broker: the tool holds a handle, the broker holds everything —
 * approval re-check, atomic single-use consumption, output scanning, secrets,
 * and the actual perform. These tests are the trust boundary's contract.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialBroker,
  OutboxAdapter,
  ResendEmailAdapter,
  WebhookPublishAdapter,
  SecretStore,
  scanOutput,
  type PerformRequest,
} from "../src/broker/broker.js";
import type { Approval } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
function outboxDir(): string {
  const d = mkdtempSync(join(tmpdir(), "neop-brk-"));
  dirs.push(d);
  return d;
}

function req(over: Partial<PerformRequest> = {}): PerformRequest {
  return {
    owner: "mansi",
    runId: "r1",
    taskId: "content-draft",
    tool: "publish_post",
    actionKey: "content-draft:2026-07-31:abc123",
    params: { body: "The verifier is not the doer." },
    ...over,
  };
}

function makeBroker(opts: { approved?: boolean; consumed?: boolean; dir?: string; allow?: string[] } = {}) {
  const dir = opts.dir ?? outboxDir();
  const approval: Approval | null = opts.approved === false
    ? null
    : {
        runId: "r1",
        actionKey: req().actionKey,
        decision: "approve",
        approvedBy: "op",
        ts: "t",
        ...(opts.consumed ? { consumedAt: "t2" } : {}),
      };
  let consumed = opts.consumed ?? false;
  const broker = new CredentialBroker({
    findApproval: () => approval,
    consume: () => {
      if (consumed) return false;
      consumed = true;
      return true;
    },
    outboxDir: dir,
    urlAllowlist: opts.allow ?? ["northwind.example"],
  });
  return { broker, dir };
}

describe("the broker's refusals (they are the §8.2 product)", () => {
  it("no approval → refused; the agent's word counts for nothing", async () => {
    const { broker } = makeBroker({ approved: false });
    const out = await broker.perform(req());
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toMatch(/no valid approval/);
  });

  it("already-consumed key → duplicate refused (at-most-once)", async () => {
    const { broker } = makeBroker({ consumed: true });
    const out = await broker.perform(req());
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toMatch(/already used/);
  });

  it("placeholder in final copy → refused BEFORE the key is burned", async () => {
    const { broker } = makeBroker();
    const bad = await broker.perform(req({ params: { body: "Q3 numbers: {{revenue}} TODO check" } }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.refusal).toMatch(/placeholder/);
    // the key was NOT consumed by the scan refusal — fixed copy is a NEW key anyway,
    // but the same key must still be performable once the content passes
    const good = await broker.perform(req());
    expect(good.ok).toBe(true);
  });

  it("URL off the allowlist → refused", async () => {
    const { broker } = makeBroker();
    const out = await broker.perform(req({ params: { body: "read more at https://evil.example/post" } }));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toMatch(/allowlist/);
    const ok = await broker.perform(req({ params: { body: "https://docs.northwind.example/changelog" } }));
    expect(ok.ok).toBe(true);
  });

  it("unknown tool → refused (fail closed)", async () => {
    const { broker } = makeBroker();
    const out = await broker.perform(req({ tool: "launch_missiles" }));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toMatch(/no adapter/);
  });
});

describe("outbox adapter (the keyless default)", () => {
  it("performs by writing a receipt — evidence, no external effect", async () => {
    const { broker, dir } = makeBroker();
    const out = await broker.perform(req());
    expect(out.ok).toBe(true);
    const line = readFileSync(join(dir, "publish_post.jsonl"), "utf8");
    expect(line).toContain("The verifier is not the doer.");
    expect(line).toContain(out.ok ? out.receipt : "");
  });
});

describe("secrets: (owner, name) with default fallback", () => {
  it("owner-specific beats default; default fills gaps; absent is undefined", () => {
    const s = new SecretStore({
      NEOP_SECRET_MANSI_RESEND_API_KEY: "owner-key",
      NEOP_SECRET_DEFAULT_RESEND_API_KEY: "default-key",
      NEOP_SECRET_DEFAULT_MAIL_FROM: "neop@northwind.example",
    });
    expect(s.get("mansi", "RESEND_API_KEY")).toBe("owner-key");
    expect(s.get("someone-else", "RESEND_API_KEY")).toBe("default-key");
    expect(s.get("mansi", "MAIL_FROM")).toBe("neop@northwind.example");
    expect(s.get("mansi", "NOPE")).toBeUndefined();
  });
});

describe("real adapters (zero-dep, fetch-shaped)", () => {
  it("resend adapter refuses without a key, sends with one (fetch stubbed)", async () => {
    const adapter = new ResendEmailAdapter();
    const noKey = new SecretStore({});
    await expect(
      adapter.perform(req({ tool: "send_email", params: { to: "a@b.c", subject: "s", body: "b" } }), noKey, fetch),
    ).rejects.toThrow(/RESEND_API_KEY/);

    const withKey = new SecretStore({ NEOP_SECRET_DEFAULT_RESEND_API_KEY: "rk" });
    const calls: { url: string; auth: string }[] = [];
    const fakeFetch = (async (url: unknown, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url: String(url), auth: init.headers.authorization ?? "" });
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await adapter.perform(
      req({ tool: "send_email", params: { to: "a@b.c", subject: "s", body: "b" } }),
      withKey,
      fakeFetch,
    );
    expect(out.receipt).toBe("email_123");
    expect(calls[0]!.url).toContain("api.resend.com");
    expect(calls[0]!.auth).toBe("Bearer rk");
  });

  it("webhook adapter posts to the operator-configured URL (real local server)", async () => {
    const received: string[] = [];
    const server = createServer((rq, rs) => {
      let b = "";
      rq.on("data", (c) => (b += c));
      rq.on("end", () => {
        received.push(b);
        rs.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(8141, r));
    try {
      const adapter = new WebhookPublishAdapter();
      const secrets = new SecretStore({ NEOP_SECRET_DEFAULT_PUBLISH_WEBHOOK_URL: "http://localhost:8141/hook" });
      const out = await adapter.perform(req(), secrets, fetch);
      expect(out.receipt).toContain("webhook-200");
      expect(received[0]).toContain("The verifier is not the doer.");
    } finally {
      server.close();
    }
  });
});

describe("scanOutput", () => {
  it("catches every placeholder family and passes clean copy", () => {
    expect(scanOutput({ body: "ship {{x}}" }, [])).toMatch(/placeholder/);
    expect(scanOutput({ body: "TODO tighten" }, [])).toMatch(/placeholder/);
    expect(scanOutput({ body: "TKTK numbers" }, [])).toMatch(/placeholder/);
    expect(scanOutput({ body: "clean copy, 99.97% uptime" }, [])).toBeNull();
  });
});

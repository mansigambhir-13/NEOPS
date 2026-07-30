import { describe, it, expect } from "vitest";
import { MockClient } from "../src/api/client.js";

describe("MockClient — the zero-backend runtime", () => {
  it("bootstraps metrics, chats, runs, ticks", async () => {
    const b = await new MockClient().getBootstrap();
    expect(b.metrics).toBeTruthy();
    expect(b.chats.length).toBeGreaterThan(0);
    expect(b.runs.length).toBeGreaterThan(0);
    expect(b.ticks.length).toBeGreaterThan(0);
    // runs are already mapped to the console view-model
    expect(b.runs[0]).toHaveProperty("verdict");
  });

  it("infers approve vs deny from the option text", async () => {
    const c = new MockClient();
    const approve = await c.decideGate("7b09", "publish_public", "Publish all five");
    const deny = await c.decideGate("7a55", "send_external_email", "Don't send");
    expect(approve.decision).toBe("approve");
    expect(deny.decision).toBe("deny");
  });

  it("is idempotent — a repeated decision returns the first, never a second", async () => {
    const c = new MockClient();
    const first = await c.decideGate("7b09", "publish_public", "Publish all five");
    const again = await c.decideGate("7b09", "publish_public", "Hold, I'll edit"); // different option
    expect(again).toEqual(first); // the first decision stands (§6.2)
    expect(again.decision).toBe("approve");
  });

  it("carries an actionKey and approver on every approval", async () => {
    const a = await new MockClient().decideGate("6f2d", "publish_public", "Publish");
    expect(a.actionKey).toBe("6f2d:publish_public");
    expect(a.approvedBy).toBeTruthy();
    expect(a.ts).toMatch(/\dT\d/); // ISO-ish
  });

  it("sendMessage returns a NEOP reply and appends it to the thread", async () => {
    const c = new MockClient();
    const reply = await c.sendMessage("c1", "why did doc-sync veto?");
    expect(reply.who).toBe("neop");
    const thread = await c.getThread("c1");
    expect(thread[thread.length - 1]).toEqual(reply);
  });
});

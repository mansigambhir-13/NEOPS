/**
 * Brokered action tools — the worker-side half of §8.2.
 *
 * The tool the model sees is ordinary; its execute() holds NO credential and makes
 * NO network call. It derives the same actionKey the gate derived (shared
 * contentHash over the identical args) and hands the whole request to the broker,
 * which re-checks the approval, consumes the key, scans, and performs.
 *
 * The tool's text result tells the model the truth: receipt on success, the
 * broker's refusal verbatim on refusal — "you will have wasted a turn" as promised.
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { actionKey, contentHash } from "../policy.js";
import type { CredentialBroker } from "./broker.js";

export interface BrokerRunContext {
  owner: string;
  runId: string;
  taskId: string;
  logicalDate: string;
}

function text(t: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: t }], details: undefined };
}

const SCHEMAS: Record<string, { description: string; parameters: ReturnType<typeof Type.Object> }> = {
  publish_post: {
    description: "Publish finished copy to a public channel. Irreversible; parks for human approval.",
    parameters: Type.Object(
      {
        channel: Type.Optional(Type.String({ description: "target channel, e.g. linkedin" })),
        body: Type.String({ description: "Exact final copy. No placeholders." }),
      },
      { additionalProperties: true },
    ),
  },
  send_email: {
    description: "Send mail outside the organisation. Irreversible; parks for human approval.",
    parameters: Type.Object(
      {
        to: Type.String(),
        subject: Type.String(),
        body: Type.String({ description: "Final copy. No placeholders." }),
      },
      { additionalProperties: true },
    ),
  },
};

/** Build a brokered AgentTool for `name`, bound to one run's identity. */
export function makeBrokeredTool(name: string, broker: CredentialBroker, ctx: BrokerRunContext): AgentTool {
  const schema = SCHEMAS[name] ?? {
    description: `${name} (brokered action)`,
    parameters: Type.Object({}, { additionalProperties: true }),
  };
  return {
    name,
    label: name,
    description: schema.description,
    parameters: schema.parameters,
    execute: async (_id, params) => {
      const args = params as Record<string, unknown>;
      const key = actionKey(ctx.taskId, ctx.logicalDate, contentHash(name, args));
      const out = await broker.perform({
        owner: ctx.owner,
        runId: ctx.runId,
        taskId: ctx.taskId,
        tool: name,
        actionKey: key,
        params: args,
      });
      if (out.ok) return text(`${name} performed. receipt: ${out.receipt}${out.detail ? ` — ${out.detail}` : ""}`);
      throw new Error(`broker refused ${name}: ${out.refusal}`);
    },
  };
}

/**
 * Overlay brokered tools onto an existing makeTools: any bound tool the broker
 * supports becomes brokered; everything else passes through unchanged.
 */
export function withBrokeredTools<TCtx>(
  makeTools: (names: string[], toolCtx: TCtx) => AgentTool[],
  broker: CredentialBroker | null,
  ctx: BrokerRunContext,
): (names: string[], toolCtx: TCtx) => AgentTool[] {
  if (!broker) return makeTools;
  return (names, toolCtx) => {
    const brokered = new Map(names.filter((n) => broker.supports(n)).map((n) => [n, makeBrokeredTool(n, broker, ctx)]));
    const rest = names.filter((n) => !brokered.has(n));
    const built = rest.length ? makeTools(rest, toolCtx) : [];
    // preserve binding order
    return names.map((n) => brokered.get(n) ?? built[rest.indexOf(n)]!);
  };
}

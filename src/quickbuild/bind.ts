/**
 * QB2/QB3 — bind resolved registry ToolDocs to executable pi tools.
 *
 * impl dispatch:
 *   builtin:<name>   pi's real read/write/edit/bash execution, relabelled with the
 *                    registry name (the model sees `draft_post`, not `write_file`)
 *   runtime:<name>   a handler injected by the runner (Foreman's spawn/list/reap)
 *   anything else    class-correct stub that throws (same posture as action tools)
 *
 * Modes:
 *   dev (v3 §8): every IRREVERSIBLE tool becomes a logging stub that returns
 *   success — you see the whole behaviour, nothing leaves the machine.
 *
 * QB3: tools with `taint: untrusted` get their output wrapped in an
 * `<untrusted_content>` envelope — in code, not by asking the model nicely.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentTool,
  type AgentToolResult,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { bind } from "../pi/tools.js";
import type { ToolRegistry } from "../taskSchema.js";
import type { ToolDoc } from "./registry.js";

export type RuntimeHandler = (params: Record<string, unknown>) => Promise<string> | string;

export interface BindOptions {
  /** dev mode: irreversible tools become logging stubs that succeed. */
  dev?: boolean;
  /** implementations for runtime:<name> impls (Foreman verbs). */
  runtime?: Record<string, RuntimeHandler>;
  /** collects what dev-stubs *would* have done, for the run report. */
  devLog?: string[];
}

function text(t: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: t }], details: undefined };
}

/** First prose paragraph of the doc body — the model-facing short description. */
function shortDesc(doc: ToolDoc): string {
  const para = doc.body
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#"));
  return para?.replace(/\s+/g, " ").slice(0, 300) ?? doc.name;
}

const BUILTINS: Record<string, (ctx: ExecutionToolContext, name: string, desc: string) => AgentTool> = {
  read_file: (ctx, name, desc) => bind(createReadTool(), ctx, name, desc),
  write_file: (ctx, name, desc) => bind(createWriteTool(), ctx, name, desc),
  edit_file: (ctx, name, desc) => bind(createEditTool(), ctx, name, desc),
  bash: (ctx, name, desc) => bind(createBashTool(), ctx, name, desc),
};

function stub(name: string, desc: string): AgentTool {
  return {
    name,
    label: name,
    description: desc,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      throw new Error(`tool "${name}" is not wired yet (impl pending — behind the credential broker)`);
    },
  };
}

function devStub(name: string, desc: string, devLog?: string[]): AgentTool {
  return {
    name,
    label: name,
    description: `${desc} (dev mode: stubbed — logs intent, returns success)`,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_id, params) => {
      const line = `[dev-stub] ${name} would have run with ${JSON.stringify(params)}`;
      devLog?.push(line);
      return text(line);
    },
  };
}

function runtimeTool(doc: ToolDoc, handler: RuntimeHandler): AgentTool {
  return {
    name: doc.name,
    label: doc.name,
    description: shortDesc(doc),
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_id, params) => text(await handler(params as Record<string, unknown>)),
  };
}

/** QB3: wrap a tool so its output arrives inside an untrusted envelope. */
function wrapUntrusted(tool: AgentTool, docName: string): AgentTool {
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const res = await tool.execute(id, params, signal, onUpdate);
      return {
        ...res,
        content: res.content.map((c) =>
          c.type === "text"
            ? { ...c, text: `<untrusted_content source="${docName}">\n${c.text}\n</untrusted_content>` }
            : c,
        ),
      };
    },
  };
}

export interface BoundTools {
  /** worker `makeTools` replacement — returns tools in binding order. */
  makeTools: (names: string[], ctx: ExecutionToolContext) => AgentTool[];
  /** name → policy class, for the task loader. */
  registry: ToolRegistry;
}

export function bindRegistryTools(docs: ToolDoc[], opts: BindOptions = {}): BoundTools {
  const byName = new Map(docs.map((d) => [d.name, d]));
  const registry: ToolRegistry = Object.fromEntries(docs.map((d) => [d.name, d.mappedClass]));

  const makeOne = (doc: ToolDoc, ctx: ExecutionToolContext): AgentTool => {
    const desc = shortDesc(doc);
    let tool: AgentTool;
    if (opts.dev && !doc.reversible) {
      tool = devStub(doc.name, desc, opts.devLog);
    } else if (doc.impl?.startsWith("builtin:")) {
      const which = doc.impl.slice("builtin:".length);
      const make = BUILTINS[which];
      if (!make) throw new Error(`${doc.file}: unknown builtin "${which}" — known: ${Object.keys(BUILTINS).join(", ")}`);
      tool = make(ctx, doc.name, desc);
    } else if (doc.impl?.startsWith("runtime:")) {
      const which = doc.impl.slice("runtime:".length);
      const handler = opts.runtime?.[which];
      tool = handler ? runtimeTool(doc, handler) : stub(doc.name, desc);
    } else {
      tool = stub(doc.name, desc);
    }
    return doc.taint === "untrusted" ? wrapUntrusted(tool, doc.name) : tool;
  };

  return {
    makeTools: (names, ctx) =>
      names.map((n) => {
        const doc = byName.get(n);
        if (!doc) throw new Error(`tool "${n}" not in the bound registry set`);
        return makeOne(doc, ctx);
      }),
    registry,
  };
}

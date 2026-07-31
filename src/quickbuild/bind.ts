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
import { makeBrokeredTool, type BrokerRunContext } from "../broker/tools.js";
import type { CredentialBroker } from "../broker/broker.js";
import type { ToolRegistry } from "../taskSchema.js";
import type { ToolDoc } from "./registry.js";

export type RuntimeHandler = (params: Record<string, unknown>) => Promise<string> | string;

export interface BindOptions {
  /** dev mode: irreversible tools become logging stubs that succeed. */
  dev?: boolean;
  /** §8.2: perform irreversible actions through the credential broker. */
  broker?: CredentialBroker;
  brokerCtx?: BrokerRunContext;
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

/**
 * native:<name> — real implementations that ship with the engine, no per-client
 * wiring needed. web_search hits DuckDuckGo's HTML endpoint (keyless); results
 * arrive through the untrusted envelope like every other tainted source.
 */
const NATIVES: Record<string, (doc: ToolDoc, desc: string) => AgentTool> = {
  web_search: (doc, desc) => ({
    name: doc.name,
    label: doc.name,
    description: desc,
    parameters: paramsSchema(doc),
    execute: async (_id, params) => {
      const p = params as Record<string, unknown>;
      const q = String(p.query ?? "").trim();
      const limit = Math.max(1, Math.min(Number(p.limit) || 8, 20));
      if (!q) return text("error: pass {query}");
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; NEOP-research/1.0)" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return text(`web_search error: upstream ${res.status}`);
        const html = await res.text();
        const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const results: string[] = [];
        const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => strip(m[1] ?? ""));
        let m: RegExpExecArray | null;
        let i = 0;
        while ((m = re.exec(html)) && results.length < limit) {
          const raw = m[1] ?? "";
          const uddg = raw.match(/[?&]uddg=([^&]+)/)?.[1];
          const url = uddg ? decodeURIComponent(uddg) : raw;
          results.push(`${results.length + 1}. ${strip(m[2] ?? "")}\n   ${url}\n   ${snips[i] ?? ""}`);
          i += 1;
        }
        return text(results.length ? results.join("\n\n") : `no results for "${q}"`);
      } catch (e) {
        return text(`web_search error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }),
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

/**
 * Dev-mode data for an UNWIRED reversible tool. The registry doc itself carries
 * the fixture (a "## Dev fixture" section) — `neop dev` serves it so a fresh NEOP
 * can rehearse its contract before anyone wires credentials. Live mode still gets
 * the loud "not wired yet" stub; fixtures never leak into production runs.
 */
function devFixtureOf(doc: ToolDoc): string | null {
  const m = doc.body.match(/## Dev fixture\s*\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1]!.trim() : null;
}

function fixtureTool(doc: ToolDoc, desc: string, fixture: string, devLog?: string[]): AgentTool {
  return {
    name: doc.name,
    label: doc.name,
    description: desc,
    parameters: paramsSchema(doc),
    execute: async (_id, params) => {
      devLog?.push(`[dev-fixture] ${doc.name}(${JSON.stringify(params)})`);
      return text(`[dev fixture — ${doc.name} is not wired to a live system]\n${fixture}`);
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

/**
 * Frontmatter `params` → a real Typebox schema. Without this the model gets an
 * empty parameter list and calls tools with `{}` — the first live Foreman run
 * proved it (spawn_neop with no spec path). The frontmatter is the contract; the
 * model must SEE it.
 */
function paramsSchema(doc: ToolDoc): ReturnType<typeof Type.Object> {
  const props: Record<string, import("@earendil-works/pi-ai").TSchema> = {};
  for (const [key, raw] of Object.entries(doc.params ?? {})) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const desc = typeof p.desc === "string" ? { description: p.desc } : {};
    switch (p.type) {
      case "number":
        props[key] = Type.Number(desc);
        break;
      case "boolean":
        props[key] = Type.Boolean(desc);
        break;
      case "enum":
        props[key] = Array.isArray(p.values)
          ? Type.Union(p.values.map((v) => Type.Literal(String(v))), desc)
          : Type.String(desc);
        break;
      default:
        props[key] = Type.String(desc);
    }
  }
  return Type.Object(props, { additionalProperties: true });
}

function runtimeTool(doc: ToolDoc, handler: RuntimeHandler): AgentTool {
  return {
    name: doc.name,
    label: doc.name,
    description: shortDesc(doc),
    parameters: paramsSchema(doc),
    execute: async (_id, params) => text(await handler(params as Record<string, unknown>)),
  };
}

/**
 * Anchor a tool's relative `path` param under a declared prefix. A tool like
 * read_brand_facts has exactly one domain (ground-truth/) — anchoring here means
 * the model cannot mis-path it AND the tool structurally cannot reach outside its
 * domain. Live incident: the doer called path "facts.md" (no prefix), got
 * not-found, and honestly reported "ground truth missing" against files that
 * existed one directory down.
 */
function anchorPaths(tool: AgentTool, prefix: string): AgentTool {
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const p = params as Record<string, unknown>;
      if (typeof p.path === "string" && !p.path.startsWith("/")) {
        const clean = p.path.replace(/^(\.\/)+/, "");
        // a repo-root path like neops/<slug>/ground-truth/x.md re-anchors at the prefix
        const at = clean.indexOf(prefix + "/");
        p.path = at >= 0 ? clean.slice(at) : `${prefix}/${clean}`;
      }
      return tool.execute(id, params, signal, onUpdate);
    },
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
    } else if (!doc.reversible && opts.broker?.supports(doc.name) && opts.brokerCtx) {
      // credential-blind: the tool hands the broker an action key, nothing more
      tool = makeBrokeredTool(doc.name, opts.broker, opts.brokerCtx);
    } else if (doc.impl?.startsWith("builtin:")) {
      const which = doc.impl.slice("builtin:".length);
      const make = BUILTINS[which];
      if (!make) throw new Error(`${doc.file}: unknown builtin "${which}" — known: ${Object.keys(BUILTINS).join(", ")}`);
      tool = make(ctx, doc.name, desc);
      if (doc.pathPrefix) tool = anchorPaths(tool, doc.pathPrefix);
    } else if (doc.impl?.startsWith("runtime:")) {
      const which = doc.impl.slice("runtime:".length);
      const handler = opts.runtime?.[which];
      tool = handler ? runtimeTool(doc, handler) : stub(doc.name, desc);
    } else if (doc.impl?.startsWith("native:")) {
      const make = NATIVES[doc.impl.slice("native:".length)];
      if (!make) throw new Error(`${doc.file}: unknown native "${doc.impl}" — known: ${Object.keys(NATIVES).join(", ")}`);
      tool = make(doc, desc);
    } else {
      const fixture = opts.dev ? devFixtureOf(doc) : null;
      tool = fixture ? fixtureTool(doc, desc, fixture, opts.devLog) : stub(doc.name, desc);
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

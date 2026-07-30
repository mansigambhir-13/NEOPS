/**
 * Quick Build QB0 — the registry loader.
 *
 * The registry is markdown on disk: frontmatter for the machine, prose for the
 * model. This module is pure functions over files — no model, no network:
 *
 *   loadRegistry(dir)              parse + validate every tool/template doc
 *   resolveTemplate(reg, id, ...)  template → concrete toolset, with invariants
 *   generateIndex(reg)             the INDEX.md the agent reads first
 *
 * Invariants enforced HERE, not in prompts (design review findings):
 *   - taint × irreversibility: a toolset holding an untrusted-input tool AND an
 *     irreversible tool is REFUSED — "the NEOP wants to be two NEOPs", in code.
 *   - class ↔ reversibility consistency: a tool may not claim reversible:true
 *     while carrying an irreversible action class (policy.ts is the authority).
 *   - extends merge: unions for tool sets; forbidden WINS — a child requiring a
 *     tool its ancestry forbids is a load error, never a silent drop.
 *   - version pins: resolution records tool versions (open decision #2 — done).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActionClass } from "../types.js";
import { reversibilityOf } from "../policy.js";

// ---------------------------------------------------------------- doc shapes

export type Taint = "trusted" | "untrusted";

export interface ToolDoc {
  name: string;
  version: string;
  /** registry-facing class name (e.g. read_external, write_draft). */
  actionClass: string;
  /** mapped onto the worker's policy enum — the gate's vocabulary. */
  mappedClass: Exclude<ActionClass, "unknown">;
  reversible: boolean;
  taint: Taint;
  secrets: string[];
  egress: string[];
  idempotency?: string;
  impl?: string;
  params?: Record<string, unknown>;
  /** the prose the model reads — when to use, when not to, refusals. */
  body: string;
  file: string;
}

export interface TemplateContract {
  id: string;
  schedule?: string; // recorded, NOT scheduled in v1 (no scheduler by design)
  successCheck: string; // §2.2 — mandatory, same rule as everywhere else
}

export interface TemplateDoc {
  id: string;
  extendsId?: string;
  version: string;
  tools: { required: string[]; optional: string[]; forbidden: string[] };
  groundTruth: { required: string[]; agentWritable: boolean };
  resources: { tokenBudget: number; wallClock: number; concurrency: number };
  contracts: TemplateContract[];
  body: string;
  file: string;
}

export interface Registry {
  tools: Map<string, ToolDoc>;
  templates: Map<string, TemplateDoc>;
  /** non-fatal problems (a broken doc never takes the loader down — it's reported). */
  problems: string[];
}

// ------------------------------------------------- registry class → policy class

/** Registry vocabulary → the worker's ActionClass (policy.ts stays the authority). */
export const CLASS_MAP: Record<string, Exclude<ActionClass, "unknown">> = {
  read: "read",
  read_internal: "read",
  read_external: "read",
  write_draft: "workspace_write",
  workspace_write: "workspace_write",
  internal_post: "internal_post",
  pr_open: "pr_open",
  test_run: "test_run",
  publish_public: "public_publish",
  send_external: "external_email",
  external_email: "external_email",
  spend: "spend",
  prod_write: "prod_write",
  pr_merge: "pr_merge",
};

// ---------------------------------------------------------------- frontmatter

/** Split a markdown doc into YAML frontmatter + body. Throws on missing fence. */
export function splitFrontmatter(text: string, file: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter fence (--- ... ---)`);
  const meta = parseYaml(m[1]!) as Record<string, unknown>;
  if (!meta || typeof meta !== "object") throw new Error(`${file}: frontmatter is not a YAML mapping`);
  return { meta, body: m[2]!.trim() };
}

// ---------------------------------------------------------------- validation

function str(meta: Record<string, unknown>, key: string, file: string): string {
  const v = meta[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${file}: frontmatter "${key}" must be a non-empty string`);
  return v.trim();
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export function parseToolDoc(text: string, file: string): ToolDoc {
  const { meta, body } = splitFrontmatter(text, file);
  const name = str(meta, "name", file);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`${file}: tool name "${name}" must be snake_case`);
  const actionClass = str(meta, "action_class", file);
  const mappedClass = CLASS_MAP[actionClass];
  if (!mappedClass) {
    throw new Error(`${file}: unknown action_class "${actionClass}" — known: ${Object.keys(CLASS_MAP).join(", ")}`);
  }
  if (typeof meta.reversible !== "boolean") throw new Error(`${file}: "reversible" must be a boolean`);
  const reversible = meta.reversible;
  // class ↔ reversibility consistency: policy.ts is the single source of truth.
  const classReversible = reversibilityOf(mappedClass) === "reversible";
  if (reversible !== classReversible) {
    throw new Error(
      `${file}: reversible:${reversible} contradicts action_class ${actionClass} (policy says ${classReversible ? "reversible" : "irreversible"})`,
    );
  }
  const taint = str(meta, "taint", file) as Taint;
  if (taint !== "trusted" && taint !== "untrusted") throw new Error(`${file}: taint must be trusted|untrusted`);
  if (!body) throw new Error(`${file}: the prose body is the model's contract — it cannot be empty`);
  return {
    name,
    version: str(meta, "version", file),
    actionClass,
    mappedClass,
    reversible,
    taint,
    secrets: strList(meta.secrets),
    egress: strList(meta.egress),
    ...(typeof meta.idempotency === "string" ? { idempotency: meta.idempotency } : {}),
    ...(typeof meta.impl === "string" ? { impl: meta.impl } : {}),
    ...(meta.params && typeof meta.params === "object" ? { params: meta.params as Record<string, unknown> } : {}),
    body,
    file,
  };
}

export function parseTemplateDoc(text: string, file: string): TemplateDoc {
  const { meta, body } = splitFrontmatter(text, file);
  const id = str(meta, "id", file);
  const tools = (meta.tools ?? {}) as Record<string, unknown>;
  const contractsRaw = Array.isArray(meta.contracts) ? (meta.contracts as Record<string, unknown>[]) : [];
  const contracts: TemplateContract[] = contractsRaw.map((c, i) => {
    const cid = typeof c.id === "string" ? c.id : `contract-${i}`;
    const successCheck = c.success_check;
    if (typeof successCheck !== "string" || !successCheck.trim()) {
      // §2.2, unchanged since day one: a contract without a machine check cannot exist
      throw new Error(`${file}: contract "${cid}" has no success_check — refused`);
    }
    return { id: cid, successCheck, ...(typeof c.schedule === "string" ? { schedule: c.schedule } : {}) };
  });
  const gt = (meta.ground_truth ?? {}) as Record<string, unknown>;
  const res = (meta.resources ?? {}) as Record<string, unknown>;
  if (!body) throw new Error(`${file}: the template body becomes the agent's instructions — it cannot be empty`);
  return {
    id,
    ...(typeof meta.extends === "string" && meta.extends !== "none" ? { extendsId: meta.extends } : {}),
    version: str(meta, "version", file),
    tools: {
      required: strList(tools.required),
      optional: strList(tools.optional),
      forbidden: strList(tools.forbidden),
    },
    groundTruth: { required: strList(gt.required), agentWritable: gt.agent_writable === true },
    resources: {
      tokenBudget: Number(res.token_budget ?? 200_000),
      wallClock: Number(res.wall_clock ?? 900),
      concurrency: Number(res.concurrency ?? 1),
    },
    contracts,
    body,
    file,
  };
}

// ---------------------------------------------------------------- loading

export function loadRegistry(dir: string): Registry {
  const reg: Registry = { tools: new Map(), templates: new Map(), problems: [] };
  const scan = (sub: string, parse: (t: string, f: string) => void) => {
    const d = join(dir, sub);
    if (!existsSync(d)) return;
    for (const f of readdirSync(d).filter((n) => n.endsWith(".md"))) {
      const path = join(d, f);
      try {
        parse(readFileSync(path, "utf8"), `${sub}/${f}`);
      } catch (e) {
        reg.problems.push((e as Error).message);
      }
    }
  };
  scan("tools", (t, f) => {
    const doc = parseToolDoc(t, f);
    if (reg.tools.has(doc.name)) throw new Error(`${f}: duplicate tool name "${doc.name}"`);
    reg.tools.set(doc.name, doc);
  });
  scan("templates", (t, f) => {
    const doc = parseTemplateDoc(t, f);
    if (reg.templates.has(doc.id)) throw new Error(`${f}: duplicate template id "${doc.id}"`);
    reg.templates.set(doc.id, doc);
  });
  return reg;
}

// ---------------------------------------------------------------- resolution

export interface ResolvedTemplate {
  templateId: string;
  templateVersion: string;
  /** the concrete toolset the NEOP is born with (required + chosen optional). */
  tools: ToolDoc[];
  forbidden: string[];
  /** name → version, recorded at resolve time (the spec's pins). */
  pins: Record<string, string>;
  systemPrompt: string;
  groundTruth: TemplateDoc["groundTruth"];
  resources: TemplateDoc["resources"];
  contracts: TemplateContract[];
}

/** Walk `extends` chains (cycle-safe), merging per the defined rules. */
function mergeChain(reg: Registry, id: string, seen: string[] = []): TemplateDoc {
  if (seen.includes(id)) throw new Error(`template extends cycle: ${[...seen, id].join(" → ")}`);
  const doc = reg.templates.get(id);
  if (!doc) throw new Error(`unknown template "${id}" — known: ${[...reg.templates.keys()].join(", ")}`);
  if (!doc.extendsId) return doc;
  const parent = mergeChain(reg, doc.extendsId, [...seen, id]);
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    ...doc,
    tools: {
      required: union(parent.tools.required, doc.tools.required),
      optional: union(parent.tools.optional, doc.tools.optional),
      forbidden: union(parent.tools.forbidden, doc.tools.forbidden), // forbidden WINS by union
    },
    groundTruth: {
      required: union(parent.groundTruth.required, doc.groundTruth.required),
      agentWritable: doc.groundTruth.agentWritable, // child decides
    },
    contracts: doc.contracts.length ? doc.contracts : parent.contracts,
    // resources: child's values (defaults already applied at parse)
  };
}

export function resolveTemplate(
  reg: Registry,
  templateId: string,
  opts: { withOptional?: string[] } = {},
): ResolvedTemplate {
  const t = mergeChain(reg, templateId);
  const chosen = opts.withOptional ?? [];

  for (const name of chosen) {
    if (!t.tools.optional.includes(name)) {
      throw new Error(`template "${templateId}": "${name}" is not an optional tool (optional: ${t.tools.optional.join(", ") || "none"})`);
    }
  }
  // forbidden wins — a required/chosen tool that is also forbidden is a hard error
  for (const name of [...t.tools.required, ...chosen]) {
    if (t.tools.forbidden.includes(name)) {
      throw new Error(`template "${templateId}": tool "${name}" is both bound and forbidden — fix the template, not the prompt`);
    }
  }

  const names = [...new Set([...t.tools.required, ...chosen])];
  const tools = names.map((n) => {
    const doc = reg.tools.get(n);
    if (!doc) throw new Error(`template "${templateId}": unknown tool "${n}" — not in the registry`);
    return doc;
  });

  // THE invariant (§8.1 in code): untrusted input and irreversible action never
  // ride in the same NEOP. The stranger in the inbox must not be able to reach
  // the publish button through the model. This NEOP wants to be two NEOPs.
  const untrusted = tools.filter((x) => x.taint === "untrusted");
  const irreversible = tools.filter((x) => !x.reversible);
  if (untrusted.length && irreversible.length) {
    throw new Error(
      `template "${templateId}": REFUSED — untrusted-input tool(s) [${untrusted.map((x) => x.name).join(", ")}] ` +
        `and irreversible tool(s) [${irreversible.map((x) => x.name).join(", ")}] in one NEOP. ` +
        `Split it: a reader that writes a brief, and an actor that reads only the brief.`,
    );
  }

  const pins = Object.fromEntries(tools.map((x) => [x.name, x.version]));

  // the template's prose becomes the agent's instructions; each bound tool's
  // prose rides along — loaded exactly when it matters, nowhere else.
  const systemPrompt = [
    t.body,
    "",
    "---",
    "# Your tools",
    ...tools.map((x) => `\n## ${x.name}\n\n${x.body}`),
  ].join("\n");

  return {
    templateId,
    templateVersion: t.version,
    tools,
    forbidden: t.tools.forbidden,
    pins,
    systemPrompt,
    groundTruth: t.groundTruth,
    resources: t.resources,
    contracts: t.contracts,
  };
}

// ---------------------------------------------------------------- INDEX.md

export function generateIndex(reg: Registry): string {
  const tools = [...reg.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  const templates = [...reg.templates.values()].sort((a, b) => a.id.localeCompare(b.id));
  const firstLine = (b: string) => b.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
  return [
    "<!-- registry/INDEX.md — generated by `neop index`. Do not hand-edit. -->",
    "",
    "## Tools",
    "",
    "| tool | class | rev | taint | does |",
    "|---|---|---|---|---|",
    ...tools.map(
      (t) =>
        `| ${t.name} | ${t.actionClass} | ${t.reversible ? "✓" : "✗"} | ${t.taint === "untrusted" ? "**untrusted**" : "trusted"} | ${firstLine(t.body)} |`,
    ),
    "",
    "## Templates",
    "",
    "| template | version | required | optional | forbidden |",
    "|---|---|---|---|---|",
    ...templates.map(
      (t) =>
        `| ${t.id} | ${t.version} | ${t.tools.required.join(", ") || "—"} | ${t.tools.optional.join(", ") || "—"} | ${t.tools.forbidden.join(", ") || "—"} |`,
    ),
    "",
  ].join("\n");
}

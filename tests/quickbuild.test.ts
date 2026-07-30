/**
 * QB0 — registry loader invariants. Pure functions over files: no model, no network.
 * The important tests are the refusals: the loader is a filter, like the task
 * loader before it (§2.2 heritage), and the taint×irreversibility rule is §8.1
 * capability separation enforced structurally.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  loadRegistry,
  parseToolDoc,
  parseTemplateDoc,
  resolveTemplate,
  generateIndex,
  type Registry,
} from "../src/quickbuild/registry.js";

const REGISTRY_DIR = resolve("registry");

function toolDoc(over: Partial<Record<string, unknown>> = {}, body = "Does a thing.\n\n## When to use\nWhenever."): string {
  const meta: Record<string, unknown> = {
    name: "sample_tool",
    version: "1.0.0",
    action_class: "read_internal",
    reversible: true,
    taint: "trusted",
    ...over,
  };
  const yaml = Object.entries(meta)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n# t\n\n${body}`;
}

function reg(tools: string[], template: string): Registry {
  const r: Registry = { tools: new Map(), templates: new Map(), problems: [] };
  tools.forEach((t, i) => {
    const doc = parseToolDoc(t, `tools/t${i}.md`);
    r.tools.set(doc.name, doc);
  });
  const td = parseTemplateDoc(template, "templates/t.md");
  r.templates.set(td.id, td);
  return r;
}

describe("tool doc parsing", () => {
  it("parses the real read-inbox doc: untrusted taint, mapped to the gate's read class", () => {
    const r = loadRegistry(REGISTRY_DIR);
    const inbox = r.tools.get("read_inbox")!;
    expect(inbox.taint).toBe("untrusted");
    expect(inbox.actionClass).toBe("read_external");
    expect(inbox.mappedClass).toBe("read");
    expect(inbox.reversible).toBe(true);
    expect(inbox.body).toContain("written by strangers");
  });

  it("REFUSES a reversibility claim that contradicts the action class", () => {
    expect(() => parseToolDoc(toolDoc({ action_class: "publish_public", reversible: true }), "t.md")).toThrow(
      /contradicts/,
    );
    expect(() => parseToolDoc(toolDoc({ action_class: "read_internal", reversible: false }), "t.md")).toThrow(
      /contradicts/,
    );
  });

  it("REFUSES an unknown action class (fail closed, same rule as the task loader)", () => {
    expect(() => parseToolDoc(toolDoc({ action_class: "mystery_class" }), "t.md")).toThrow(/unknown action_class/);
  });

  it("REFUSES an empty body — the prose IS the model's contract", () => {
    expect(() => parseToolDoc(`---\nname: x\nversion: "1"\naction_class: read\nreversible: true\ntaint: trusted\n---\n`, "t.md")).toThrow(/body/);
  });
});

describe("template doc parsing", () => {
  it("REFUSES a contract without success_check (§2.2, unchanged since day one)", () => {
    const t = `---\nid: t\nversion: "1"\ncontracts:\n  - id: c1\n    schedule: "0 10 * * 1"\n---\n\nBody.`;
    expect(() => parseTemplateDoc(t, "t.md")).toThrow(/success_check/);
  });
});

describe("resolution invariants", () => {
  const inbox = toolDoc({ name: "read_inbox_x", action_class: "read_external", taint: "untrusted" });
  const publish = toolDoc({ name: "publish_x", action_class: "publish_public", reversible: false });
  const draft = toolDoc({ name: "draft_x", action_class: "write_draft" });

  it("THE rule: untrusted input + irreversible action in one NEOP is refused", () => {
    const t = `---\nid: bad\nversion: "1"\ntools:\n  required: [read_inbox_x, publish_x]\n---\n\nBody.`;
    const r = reg([inbox, publish], t);
    expect(() => resolveTemplate(r, "bad")).toThrow(/REFUSED/);
  });

  it("the same rule fires when the untrusted tool arrives via an optional choice", () => {
    const t = `---\nid: sneaky\nversion: "1"\ntools:\n  required: [publish_x]\n  optional: [read_inbox_x]\n---\n\nBody.`;
    const r = reg([inbox, publish], t);
    expect(() => resolveTemplate(r, "sneaky", { withOptional: ["read_inbox_x"] })).toThrow(/REFUSED/);
    // without the optional it resolves fine — publish alone is legitimate
    expect(resolveTemplate(r, "sneaky").tools.map((x) => x.name)).toEqual(["publish_x"]);
  });

  it("forbidden WINS: a required tool that is also forbidden is a hard error", () => {
    const t = `---\nid: conflicted\nversion: "1"\ntools:\n  required: [draft_x]\n  forbidden: [draft_x]\n---\n\nBody.`;
    const r = reg([draft], t);
    expect(() => resolveTemplate(r, "conflicted")).toThrow(/both bound and forbidden/);
  });

  it("unknown tools and unknown templates are named errors, not silence", () => {
    const t = `---\nid: t\nversion: "1"\ntools:\n  required: [ghost_tool]\n---\n\nBody.`;
    const r = reg([], t);
    expect(() => resolveTemplate(r, "t")).toThrow(/unknown tool "ghost_tool"/);
    expect(() => resolveTemplate(r, "nope")).toThrow(/unknown template/);
  });

  it("resolution records version pins (open decision #2 — decided: yes, in v1)", () => {
    const r = loadRegistry(REGISTRY_DIR);
    const m = resolveTemplate(r, "marketing", { withOptional: ["publish_post"] });
    expect(m.pins["publish_post"]).toBe("2.1.0");
    expect(m.pins["read_brand_facts"]).toBe("1.0.0");
  });
});

describe("the real seed registry", () => {
  it("loads with zero problems", () => {
    const r = loadRegistry(REGISTRY_DIR);
    expect(r.problems).toEqual([]);
    expect(r.tools.size).toBeGreaterThanOrEqual(6);
    expect(r.templates.size).toBeGreaterThanOrEqual(3);
  });

  it("marketing extends base: charter text present, forbidden inherited/unioned", () => {
    const r = loadRegistry(REGISTRY_DIR);
    const m = resolveTemplate(r, "marketing");
    expect(m.systemPrompt).toContain("Never invents a number");
    expect(m.forbidden).toContain("read_inbox");
    // bound tool prose rides along — loaded exactly when it matters
    expect(m.systemPrompt).toContain("read_brand_facts");
    expect(m.groundTruth.required).toEqual(expect.arrayContaining(["brand.md", "facts.md"]));
  });

  it("marketing WITH publish resolves (trusted-only surface) — and adding an inbox would not", () => {
    const r = loadRegistry(REGISTRY_DIR);
    const m = resolveTemplate(r, "marketing", { withOptional: ["publish_post"] });
    expect(m.tools.some((t) => t.name === "publish_post")).toBe(true);
    expect(m.tools.every((t) => t.taint === "trusted")).toBe(true);
  });

  it("INDEX.md generation is deterministic and marks untrusted taint", () => {
    const r = loadRegistry(REGISTRY_DIR);
    const a = generateIndex(r);
    expect(a).toBe(generateIndex(r));
    expect(a).toContain("| read_inbox | read_external | ✓ | **untrusted** |");
    expect(a).toContain("| marketing |");
  });
});

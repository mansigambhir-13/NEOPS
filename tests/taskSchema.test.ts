import { describe, it, expect } from "vitest";
import { loadTaskContract, loadTaskFromYaml, TaskLoadError, MAX_TOOLS } from "../src/taskSchema.js";
import { REGISTRY } from "./fixtures.js";

const base = {
  id: "doc-sync",
  description: "regenerate docs",
  systemPrompt: "you are neop",
  tools: [{ name: "read_file" }, { name: "edit_file" }],
  successCheck: "npm run docs:check",
};

describe("§2.2 machine-checkable done", () => {
  it("loads a valid task and resolves tool classes from the registry", () => {
    const t = loadTaskContract(base, REGISTRY);
    expect(t.tools).toEqual([
      { name: "read_file", class: "read" },
      { name: "edit_file", class: "workspace_write" },
    ]);
    expect(t.scope).toBe("doc-sync"); // defaults to id
  });

  it("REFUSES a task with no successCheck", () => {
    const { successCheck, ...noCheck } = base;
    expect(() => loadTaskContract(noCheck, REGISTRY)).toThrow(TaskLoadError);
  });

  it("REFUSES a task with an empty successCheck", () => {
    expect(() => loadTaskContract({ ...base, successCheck: "" }, REGISTRY)).toThrow(/successCheck/i);
  });
});

describe("§0 narrow task contracts", () => {
  it(`REFUSES more than ${MAX_TOOLS} tools`, () => {
    const tools = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({ name: `read_file`, class: "read" as const }));
    expect(() => loadTaskContract({ ...base, tools }, REGISTRY)).toThrow(/at most/i);
  });

  it(`allows exactly ${MAX_TOOLS} tools`, () => {
    const tools = Array.from({ length: MAX_TOOLS }, () => ({ name: "read_file" }));
    expect(() => loadTaskContract({ ...base, tools }, REGISTRY)).not.toThrow();
  });
});

describe("§2.1 fail-closed tool classification", () => {
  it("REFUSES a tool with no known class (not in task, not in registry)", () => {
    const t = { ...base, tools: [{ name: "mystery_tool" }] };
    expect(() => loadTaskContract(t, REGISTRY)).toThrow(/no known action class/i);
  });

  it("accepts a tool that declares its own class even if absent from registry", () => {
    const t = { ...base, tools: [{ name: "novel_read", class: "read" }] };
    const loaded = loadTaskContract(t, REGISTRY);
    expect(loaded.tools[0]).toEqual({ name: "novel_read", class: "read" });
  });
});

describe("YAML loading", () => {
  it("parses and loads a YAML task body", () => {
    const yaml = `
id: doc-sync
description: regenerate docs
systemPrompt: you are neop
successCheck: "npm run docs:check"
tools:
  - name: read_file
  - name: edit_file
`;
    const t = loadTaskFromYaml(yaml, REGISTRY);
    expect(t.id).toBe("doc-sync");
    expect(t.tools).toHaveLength(2);
  });

  it("throws a TaskLoadError on malformed YAML", () => {
    expect(() => loadTaskFromYaml("id: [unclosed", REGISTRY)).toThrow(TaskLoadError);
  });
});

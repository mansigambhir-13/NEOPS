import { describe, it, expect } from "vitest";
import { verify, staticChecks } from "../src/verify.js";
import { FakeRuntime } from "../src/runtime/fakeRuntime.js";
import { task, artifacts } from "./fixtures.js";

const PASS_JSON = new FakeRuntime(
  { actions: [], artifacts: artifacts() },
  { text: '{"pass": true, "reasons": ["diff matches task"]}' },
);
const VETO_JSON = new FakeRuntime(
  { actions: [], artifacts: artifacts() },
  { text: '{"pass": false, "reasons": ["diff does not regenerate docs"]}' },
);
const GARBAGE = new FakeRuntime(
  { actions: [], artifacts: artifacts() },
  { text: "the model rambled and returned no json" },
);

const cfg = { runId: "run-1", model: "small", expectedPaths: ["docs/api"], allowTestChanges: false };

describe("§6.1 independent verifier", () => {
  it("passes a clean, in-scope, green run", async () => {
    const v = await verify(PASS_JSON, artifacts(), task(), cfg);
    expect(v.pass).toBe(true);
  });

  it("vetoes when the cold model says the diff does not do the work", async () => {
    const v = await verify(VETO_JSON, artifacts(), task(), cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/does not/i);
  });

  it("FAILS CLOSED when the verifier returns unparseable output", async () => {
    const v = await verify(GARBAGE, artifacts(), task(), cfg);
    expect(v.pass).toBe(false);
  });
});

describe("§12 gaming defences (static, no model needed)", () => {
  it("vetoes test tampering when tests were not in scope", async () => {
    const a = artifacts({ filesChanged: ["docs/api/index.md", "tests/foo.test.ts"] });
    const v = await verify(PASS_JSON, a, task(), cfg);
    expect(v.pass).toBe(false);
    expect(v.testsTampered).toBe(true);
  });

  it("vetoes out-of-scope file changes", async () => {
    const a = artifacts({ filesChanged: ["docs/api/index.md", "src/secret.ts"] });
    const v = await verify(PASS_JSON, a, task(), cfg);
    expect(v.pass).toBe(false);
    expect(v.outOfScope).toBe(true);
  });

  it("vetoes a diff that leaks a secret", async () => {
    const a = artifacts({ diff: "+ const k = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'" });
    const s = staticChecks(a, task(), cfg);
    expect(s.secretsSuspected).toBe(true);
  });

  it("vetoes a run whose successCheck was red", async () => {
    const a = artifacts({ successCheck: { exitCode: 1, stdout: "", stderr: "boom" } });
    const v = await verify(PASS_JSON, a, task(), cfg);
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/exited 1/);
  });

  it("allows test changes when the task explicitly permits them", async () => {
    const a = artifacts({ filesChanged: ["tests/foo.test.ts"] });
    const v = await verify(PASS_JSON, a, task(), { ...cfg, allowTestChanges: true, expectedPaths: ["tests"] });
    expect(v.pass).toBe(true);
  });
});

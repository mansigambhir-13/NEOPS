/** Shared test builders. Keep runs deterministic — no Date.now, no randomness. */

import type { ActionRequest, RunArtifacts } from "../src/types.js";
import type { TaskContract, ToolRegistry } from "../src/taskSchema.js";
import type { AdmissionCheck, ApprovalStore, Clock } from "../src/lifecycle.js";
import type { Approval } from "../src/types.js";

export const REGISTRY: ToolRegistry = {
  read_file: "read",
  edit_file: "workspace_write",
  run_build: "test_run",
  post_internal: "internal_post",
  open_pr: "pr_open",
  publish_post: "public_publish",
  send_email: "external_email",
  charge_card: "spend",
  git: "workspace_write",
};

export function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: "doc-sync",
    description: "Regenerate docs from source and ensure the build passes.",
    systemPrompt: "You are NEOP running doc-sync.",
    tools: [
      { name: "read_file", class: "read" },
      { name: "edit_file", class: "workspace_write" },
      { name: "run_build", class: "test_run" },
    ],
    successCheck: "npm run docs:check",
    scope: "docs",
    ...overrides,
  };
}

export function artifacts(overrides: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    diff: "--- a/docs/api/index.md\n+++ b/docs/api/index.md\n+generated",
    filesChanged: ["docs/api/index.md"],
    successCheck: { exitCode: 0, stdout: "ok", stderr: "" },
    actions: [],
    ...overrides,
  };
}

export function action(over: Partial<ActionRequest> = {}): ActionRequest {
  return { tool: "edit_file", ...over };
}

/** A clock that advances by a fixed step on each call, starting at 0. */
export function fakeClock(stepMs = 1000): Clock {
  let t = 0;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

export const ADMIT_ALL: AdmissionCheck = { admit: () => ({ ok: true }) };
export const ADMIT_NONE: AdmissionCheck = {
  admit: () => ({ ok: false, reason: "circuit breaker open" }),
};

export function approvalStore(approvals: Approval[] = []): ApprovalStore {
  const byKey = new Map(approvals.map((a) => [a.actionKey, a]));
  return { find: (k) => byKey.get(k) ?? null };
}

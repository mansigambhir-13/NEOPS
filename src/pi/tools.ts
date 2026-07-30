/**
 * The NEOP tool surface, expressed as pi-agent-core tools (§0: broad tool surface,
 * narrow task contracts).
 *
 * Two kinds live here:
 *   - REAL tools that delegate to pi's built-in execution (read/edit/write/bash),
 *     scoped to the run's worktree via the injected ExecutionToolContext.
 *   - STUB action tools (publish_post, send_email, …) that carry the correct
 *     ActionClass so the loader admits them and the gate classifies them, but throw
 *     until wired behind the credential broker in a later phase.
 *
 * Every tool has ONE action class (the class registry is the single place
 * classification is auditable — mirrors §2.1). The gate resolves reversibility from
 * the class; standing denials (policy.ts) catch the dangerous specifics (force-push,
 * merge-to-main, destructive SQL, secret reads) regardless of class.
 */

import { isAbsolute, join } from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { ActionClass, ActionRequest } from "../types.js";
import type { ToolRegistry } from "../taskSchema.js";

type Cls = Exclude<ActionClass, "unknown">;

/** How a tool is built and classified. */
interface ToolSpec {
  class: Cls;
  make: (ctx: ExecutionToolContext) => AgentTool;
}

/**
 * Adapt a built-in harness tool (whose `execute` takes a 5th context arg) into a
 * plain AgentTool that closes over the run's context, and relabel it with the NEOP
 * name. This is the seam that turns pi's real read/edit/write/bash execution into a
 * NEOP-named, single-classed tool.
 */
export function bind<S extends TSchema, D>(
  tool: AgentHarnessTool<ExecutionToolContext, S, D>,
  ctx: ExecutionToolContext,
  name: string,
  description?: string,
): AgentTool<S, D> {
  return {
    name,
    label: name,
    description: description ?? tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    execute: (id, params, signal, onUpdate) => tool.execute(id, params, signal, onUpdate, ctx),
  };
}

/** A not-yet-wired action tool. It throws if it ever executes; irreversible ones
 * are parked by the gate BEFORE execute is ever reached. */
function stub(name: string, description: string): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      throw new Error(`tool "${name}" is not wired yet (Phase 2+ — behind the credential broker)`);
    },
  };
}

/**
 * The tool catalogue. The KEY is the NEOP tool name a task binds; the value knows
 * its class and how to build it. Adding a tool means classifying it here — nowhere else.
 */
const SPECS: Record<string, ToolSpec> = {
  // --- reversible, real execution inside the worktree ---
  read_file: { class: "read", make: (ctx) => bind(createReadTool(), ctx, "read_file") },
  list_files: {
    class: "read",
    make: (ctx) =>
      bind(createBashTool({ commandPrefix: "set -euo pipefail" }), ctx, "list_files", "List files. Provide a read-only shell command (ls, find, cat, grep)."),
  },
  edit_file: { class: "workspace_write", make: (ctx) => bind(createEditTool(), ctx, "edit_file") },
  write_file: { class: "workspace_write", make: (ctx) => bind(createWriteTool(), ctx, "write_file") },
  run_build: { class: "test_run", make: (ctx) => bind(createBashTool(), ctx, "run_build", "Run the project build. Provide the build command.") },
  run_tests: { class: "test_run", make: (ctx) => bind(createBashTool(), ctx, "run_tests", "Run the project tests. Provide the test command.") },
  git: {
    class: "workspace_write",
    make: (ctx) => bind(createBashTool({ commandPrefix: "git" }), ctx, "git", "Run a git subcommand (e.g. 'status', 'add -A', 'commit -m ...'). Force-push and merges to protected branches are denied."),
  },

  // --- reversible, not yet wired ---
  open_pr: { class: "pr_open", make: () => stub("open_pr", "Open a pull request from the run's branch.") },
  internal_post: { class: "internal_post", make: () => stub("internal_post", "Post a message to an internal (non-public) channel.") },

  // --- IRREVERSIBLE: gate parks these for a human before execution ---
  publish_post: { class: "public_publish", make: () => stub("publish_post", "Publish content to a public surface.") },
  send_email: { class: "external_email", make: () => stub("send_email", "Send email outside the organisation.") },
  merge_pr: { class: "pr_merge", make: () => stub("merge_pr", "Merge a pull request to a protected branch.") },
  deploy: { class: "prod_write", make: () => stub("deploy", "Write/deploy to production state.") },
  purchase: { class: "spend", make: () => stub("purchase", "Make a purchase / incur spend.") },
};

/** name → class, consumed by the task loader (§2.2 class resolution). */
export const TOOL_REGISTRY: ToolRegistry = Object.fromEntries(
  Object.entries(SPECS).map(([name, spec]) => [name, spec.class]),
);

/** Build exactly the tools a task binds — nothing is inherited (§5 step 3). */
export function makeTools(names: string[], ctx: ExecutionToolContext): AgentTool[] {
  return names.map((name) => {
    const spec = SPECS[name];
    if (!spec) throw new Error(`unknown tool "${name}" — not in the NEOP tool registry`);
    return spec.make(ctx);
  });
}

function resolveTargetPath(worktreeRoot: string, args: Record<string, unknown>): string | undefined {
  const p = args.path;
  if (typeof p !== "string" || p.length === 0) return undefined;
  return isAbsolute(p) ? p : join(worktreeRoot, p);
}

function resolveTargetHost(args: Record<string, unknown>): string | undefined {
  const raw = args.url ?? args.host ?? args.to;
  if (typeof raw !== "string") return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return typeof args.host === "string" ? args.host : undefined;
  }
}

/**
 * Translate a pi tool call into the ActionRequest the gate rules over. The declared
 * class comes from the task binding (authoritative), never from the agent.
 */
export function toActionRequest(
  toolName: string,
  args: Record<string, unknown>,
  declaredClass: ActionClass,
  worktreeRoot: string,
): ActionRequest {
  return {
    tool: toolName,
    declaredClass,
    args,
    targetPath: resolveTargetPath(worktreeRoot, args),
    targetHost: resolveTargetHost(args),
  };
}

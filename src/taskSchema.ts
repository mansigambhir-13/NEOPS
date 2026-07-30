/**
 * §2.2 Machine-checkable done + §0 narrow task contracts.
 *
 * The loader is a filter, not a parser. Its whole job is to REFUSE tasks that would
 * fail silently at 3am:
 *   - no `successCheck`               → rejected (invariant #2)
 *   - more than MAX_TOOLS tools       → rejected (§0: no run gets more than six)
 *   - a tool with no known action class → rejected (fail closed, §2.1)
 *
 * A task that loads is a task that can be judged by a command that exits 0.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { ActionClass } from "./types.js";

/** §0: broad tool surface, narrow task contracts. Hard cap per run. */
export const MAX_TOOLS = 6;

/** The action classes a tool may legally declare (excludes the `unknown` sentinel). */
const KNOWN_CLASSES = [
  "read",
  "workspace_write",
  "internal_post",
  "pr_open",
  "test_run",
  "public_publish",
  "external_email",
  "spend",
  "prod_write",
  "pr_merge",
] as const satisfies readonly ActionClass[];

const actionClassSchema = z.enum(KNOWN_CLASSES);

/** A tool binding inside a task: the name plus its declared action class. */
const toolBindingSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, "tool names are snake_case"),
  /**
   * Class MAY be omitted here if the tool declares it in its own contract; but at
   * least one of the two must resolve. The loader cross-checks against the registry
   * (see resolveClasses) and rejects anything that stays `unknown`.
   */
  class: actionClassSchema.optional(),
});

/**
 * The task contract schema. `successCheck` is required by the schema itself — the
 * loader cannot produce a valid task without it.
 */
export const taskContractSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, "task ids are kebab-case"),
    description: z.string().min(1),
    /** The system prompt assembled for the AgentSession (§5 step 3). */
    systemPrompt: z.string().min(1),
    /** Tools the run may hold — nothing is inherited (§5 step 3). */
    tools: z.array(toolBindingSchema).max(MAX_TOOLS, `a run may hold at most ${MAX_TOOLS} tools`),
    /** §2.2: the command whose exit 0 defines success. Mandatory. */
    successCheck: z.string().min(1, "successCheck is mandatory — a task without it cannot run unattended"),
    /** Scope lock name for concurrency (§6.5). Defaults to the task id. */
    scope: z.string().min(1).optional(),
    /** Cron schedule; absent = manual trigger only (Phase 0). */
    schedule: z.string().optional(),
    /** Per-run ceilings override (§2.3). */
    ceilings: z
      .object({
        maxTokens: z.number().int().positive().optional(),
        maxSubagentDepth: z.number().int().min(0).max(2).optional(),
        wallClockMs: z.number().int().positive().optional(),
        maxActions: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export type ToolBinding = z.infer<typeof toolBindingSchema>;
export type RawTaskContract = z.infer<typeof taskContractSchema>;

/** A task after class resolution — every tool has a concrete, known class. */
export interface TaskContract extends Omit<RawTaskContract, "tools"> {
  tools: { name: string; class: Exclude<ActionClass, "unknown"> }[];
  scope: string;
}

/**
 * The tool registry: the ground-truth class for every tool NEOP knows about.
 * A task may bind a tool without restating its class; the loader fills it from here.
 * A tool absent from both the task binding and the registry stays `unknown` and the
 * load fails (§2.1 fail-closed).
 */
export type ToolRegistry = Record<string, Exclude<ActionClass, "unknown">>;

export class TaskLoadError extends Error {
  constructor(
    message: string,
    readonly taskId?: string,
  ) {
    super(message);
    this.name = "TaskLoadError";
  }
}

/**
 * Resolve each tool binding to a concrete class, using the task's own declaration
 * first, then the registry. Throws if any tool cannot be classified.
 */
function resolveClasses(raw: RawTaskContract, registry: ToolRegistry): TaskContract["tools"] {
  return raw.tools.map((t) => {
    const cls = t.class ?? registry[t.name];
    if (!cls) {
      throw new TaskLoadError(
        `tool "${t.name}" has no known action class (not declared in task, not in registry) — failing closed`,
        raw.id,
      );
    }
    return { name: t.name, class: cls };
  });
}

/**
 * Load and validate a task contract from a raw object (already parsed).
 * This is the single choke point invariant #2 is enforced at.
 */
export function loadTaskContract(input: unknown, registry: ToolRegistry): TaskContract {
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    throw new TaskLoadError(`invalid task contract at ${where}: ${first?.message ?? "unknown error"}`);
  }
  const raw = parsed.data;
  const tools = resolveClasses(raw, registry);
  return { ...raw, tools, scope: raw.scope ?? raw.id };
}

/** Parse a YAML task file body and load it. */
export function loadTaskFromYaml(yamlText: string, registry: ToolRegistry): TaskContract {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    throw new TaskLoadError(`task YAML failed to parse: ${(e as Error).message}`);
  }
  return loadTaskContract(doc, registry);
}

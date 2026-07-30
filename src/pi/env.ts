/**
 * The execution environment handed to the built-in tools. It is the ONLY place a
 * cwd lives — pinning it to the run's git worktree is the first half of the
 * worktree jail (§8.3); the gate enforces the second half on every write.
 */

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core";

/** Build a worktree-scoped tool context for a run. */
export function makeToolContext(worktreeRoot: string): ExecutionToolContext {
  return { env: new NodeExecutionEnv({ cwd: worktreeRoot }) };
}

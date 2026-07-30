/**
 * Container bootstrap: Quick Build needs a REAL git repo (worktrees per run, the
 * Foreman's pinned-ref boot), but a Docker image ships no .git and its filesystem
 * is ephemeral. So the plane seeds a repo on the persistent volume at first start:
 *
 *   /data/repo/            git-initialised, committed
 *     registry/            synced from the image (re-synced + committed on updates)
 *     tasks/
 *     neops/               spawned specs — persist across container restarts
 *     .neop/               worktrees + sessions
 *
 * Local dev never calls this — the working checkout IS the repo. Only an explicit
 * NEOP_REPO_ROOT (set by the Dockerfile) triggers it.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export interface BootstrapSeed {
  registryDir?: string;
  tasksDir?: string;
}

export function ensureQuickbuildRepo(repoRoot: string, seed: BootstrapSeed): { created: boolean; synced: boolean } {
  const fresh = !existsSync(join(repoRoot, ".git"));
  mkdirSync(repoRoot, { recursive: true });

  if (fresh) {
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "neop@local"]);
    git(repoRoot, ["config", "user.name", "neop"]);
    mkdirSync(join(repoRoot, "neops"), { recursive: true });
    writeFileSync(join(repoRoot, "neops", ".keep"), "");
  }

  // sync the library from the image — image updates land as a commit, so the
  // Foreman's "last known good ref" story keeps working across deploys
  if (seed.registryDir && existsSync(seed.registryDir)) {
    cpSync(seed.registryDir, join(repoRoot, "registry"), { recursive: true });
  }
  if (seed.tasksDir && existsSync(seed.tasksDir)) {
    cpSync(seed.tasksDir, join(repoRoot, "tasks"), { recursive: true });
  }

  const dirty = git(repoRoot, ["status", "--porcelain"]).trim().length > 0;
  if (dirty) {
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-q", "-m", fresh ? "seed: quick build repo" : "sync: registry from image"]);
  }
  return { created: fresh, synced: dirty };
}

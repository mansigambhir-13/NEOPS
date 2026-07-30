/** Throwaway git repo helper for real-worktree end-to-end tests. */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Create a throwaway git repo to act as the base + worktree. */
export function makeRepo(dir: string, seedFiles: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init -q");
  git(dir, 'config user.email "t@t.t"');
  git(dir, 'config user.name "t"');
  for (const [rel, content] of Object.entries(seedFiles)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  git(dir, "add -A");
  git(dir, "commit -q -m seed --allow-empty");
}

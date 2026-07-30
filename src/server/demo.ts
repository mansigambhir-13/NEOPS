/**
 * Demo mode: real runs, no key.
 *
 * Uses pi-ai's faux provider to script the doer's turns and the verifier's ruling,
 * exactly as the test suite does — so a demo run still exercises the REAL worker:
 * real pi Agent loop, real gate, real worktree, real file writes, real successCheck.
 * The only fake thing is the model's text. This is what lets the console be wired
 * end-to-end before a provider key exists (NEOP_DEMO=1, or no key present).
 *
 * Each factory returns FRESH faux providers per call — response queues are consumed,
 * so a resume needs a new script.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep, ToolCall } from "@earendil-works/pi-ai";
import type { ResolvedModels } from "../pi/provider.js";

function toolTurn(...calls: ToolCall[]): FauxResponseStep {
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}
function stopTurn(text = "done"): FauxResponseStep {
  return fauxAssistantMessage(text, { stopReason: "stop" });
}
function verdictTurn(pass: boolean, reasons: string[] = []): FauxResponseStep {
  return fauxAssistantMessage(JSON.stringify({ pass, reasons }), { stopReason: "stop" });
}

/** Build fresh faux work+verify models from scripts. */
export function fauxModels(
  work: FauxResponseStep[],
  verify: FauxResponseStep[] = [verdictTurn(true, ["diff matches the task"])],
): ResolvedModels {
  const workH = fauxProvider({ provider: "faux-work", models: [{ id: "work" }] });
  const verifyH = fauxProvider({ provider: "faux-verify", models: [{ id: "verify" }] });
  const models = createModels();
  models.setProvider(workH.provider);
  models.setProvider(verifyH.provider);
  workH.setResponses(work);
  verifyH.setResponses(verify);
  const workModel = models.getModel("faux-work", "work");
  const verifyModel = models.getModel("faux-verify", "verify");
  if (!workModel || !verifyModel) throw new Error("faux models not registered");
  return { models, work: workModel, verify: verifyModel, streamFn: models.streamSimple.bind(models) };
}

/** A throwaway git repo to act as a run's worktree. */
export function makeDemoWorktree(seed: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "neop-run-"));
  const git = (args: string) => execSync(`git ${args}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init -q");
  git('config user.email "neop@local"');
  git('config user.name "neop"');
  for (const [rel, content] of Object.entries(seed)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  git("add -A");
  git("commit -q -m seed --allow-empty");
  return dir;
}

/** A demo scenario: the task shape, its worktree seed, and its model scripts. */
export interface DemoScenario {
  taskId: string;
  description: string;
  tools: { name: string; class: string }[];
  successCheck: string;
  seed: Record<string, string>;
  /** doer script for a fresh run */
  work: () => FauxResponseStep[];
  /** doer script for a resume after approval (defaults to same as work) */
  resumeWork?: () => FauxResponseStep[];
  verify?: () => FauxResponseStep[];
}

/** The three demo scenarios: a clean land, a verifier veto, and a parked publish. */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    taskId: "doc-sync",
    description: "Regenerate the API doc from source; done when the GENERATED marker is present.",
    tools: [
      { name: "read_file", class: "read" },
      { name: "edit_file", class: "workspace_write" },
    ],
    successCheck: "grep -q GENERATED docs/api/index.md",
    seed: { "docs/api/index.md": "stale\n" },
    work: () => [
      toolTurn(fauxToolCall("edit_file", { path: "docs/api/index.md", oldText: "stale\n", newText: "GENERATED from source\n" })),
      stopTurn("Doc regenerated."),
    ],
  },
  {
    taskId: "alert-triage",
    description: "Summarise last night's alerts into ops/triage.md — and nothing else.",
    tools: [
      { name: "read_file", class: "read" },
      { name: "edit_file", class: "workspace_write" },
    ],
    successCheck: "test -s ops/triage.md",
    seed: { "ops/triage.md": "placeholder\n", "tests/keep.test.ts": "// do not touch\n" },
    work: () => [
      // scope creep: also edits a test file → static veto (§12)
      toolTurn(fauxToolCall("edit_file", { path: "ops/triage.md", oldText: "placeholder\n", newText: "9 groups, top cause: redis pool\n" })),
      toolTurn(fauxToolCall("edit_file", { path: "tests/keep.test.ts", oldText: "// do not touch\n", newText: "// weakened\n" })),
      stopTurn("Triage written."),
    ],
  },
  {
    taskId: "content-draft",
    description: "Draft the week's post and publish it once approved.",
    tools: [
      { name: "edit_file", class: "workspace_write" },
      { name: "publish_post", class: "public_publish" },
    ],
    successCheck: "grep -q 'verifier is not the doer' content/draft.md",
    seed: { "content/draft.md": "TODO: draft\n" },
    work: () => [
      toolTurn(fauxToolCall("edit_file", { path: "content/draft.md", oldText: "TODO: draft\n", newText: "This week: the verifier is not the doer.\n" })),
      toolTurn(fauxToolCall("publish_post", { text: "This week: the verifier is not the doer." })),
      stopTurn("Draft ready; publish requested."),
    ],
    // On resume the draft already exists — the doer only retries the approved publish.
    resumeWork: () => [
      toolTurn(fauxToolCall("publish_post", { text: "This week: the verifier is not the doer." })),
      stopTurn("Publish attempted after approval."),
    ],
  },
];

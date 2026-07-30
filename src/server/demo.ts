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

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep, ToolCall } from "@earendil-works/pi-ai";
import type { ResolvedModels } from "../pi/provider.js";
import type { ActionRequest } from "../types.js";

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

/** A throwaway git repo to act as a run's worktree. Async — subprocesses must not
 * block the control plane's event loop (see bench/backend.ts). */
export async function makeDemoWorktree(seed: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neop-run-"));
  const git = (...args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile("git", args, { cwd: dir }, (err) => (err ? reject(err) : resolve())),
    );
  await git("init", "-q");
  await git("config", "user.email", "neop@local");
  await git("config", "user.name", "neop");
  for (const [rel, content] of Object.entries(seed)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed", "--allow-empty");
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
  /**
   * doer script for a resume after approval. Receives the PARKED action (from the
   * journal-persisted run record) so the resume republishes exactly what the human
   * approved — module state does not survive a process restart, the journal does.
   */
  resumeWork?: (parked?: ActionRequest) => FauxResponseStep[];
  verify?: () => FauxResponseStep[];
}

// content-draft's per-run draft state (see the scenario comment below)
let draftNo = 0;
let lastDraft = "This week: the verifier is not the doer.";

/** The three demo scenarios: a clean land, a verifier veto, and a parked publish. */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    taskId: "doc-sync",
    description:
      "Edit the file docs/api/index.md (it exists) and replace its entire contents with the line: GENERATED from source. Touch nothing else. Done when docs/api/index.md contains the word GENERATED.",
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
    description:
      "Write a one-paragraph triage summary of last night's alerts into the existing file ops/triage.md (replace its contents). Do not create or modify any other file. Done when ops/triage.md is non-empty.",
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
    description:
      "Read the existing file content/draft.md first, then replace its contents with a one-line post that includes the exact phrase: verifier is not the doer. Then call the publish_post tool with that post text (it may require approval — that is expected). Done when content/draft.md contains the phrase.",
    tools: [
      { name: "read_file", class: "read" },
      { name: "edit_file", class: "workspace_write" },
      { name: "publish_post", class: "public_publish" },
    ],
    successCheck: "grep -q 'verifier is not the doer' content/draft.md",
    seed: { "content/draft.md": "TODO: draft\n" },
    // Each run drafts DIFFERENT content (as reality does), so each run mints its own
    // idempotency key — approvals are single-use (§6.2) and never bleed across runs.
    // Resume republishes the SAME remembered draft, so the approval key matches.
    work: () => {
      draftNo += 1;
      lastDraft = `This week: the verifier is not the doer. (#${draftNo})`;
      return [
        toolTurn(fauxToolCall("edit_file", { path: "content/draft.md", oldText: "TODO: draft\n", newText: `${lastDraft}\n` })),
        toolTurn(fauxToolCall("publish_post", { text: lastDraft })),
        stopTurn("Draft ready; publish requested."),
      ];
    },
    resumeWork: (parked) => [
      toolTurn(fauxToolCall("publish_post", { text: (parked?.args?.text as string) ?? lastDraft })),
      stopTurn("Publish attempted after approval."),
    ],
  },
];

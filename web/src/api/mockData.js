/* Seed data for the MockClient. This is the ONLY place hardcoded runs/chats live.
   The HttpClient returns the same shapes from the live control plane, so the
   component never knows whether it's talking to mock or real. */

export const METRICS = {
  contracts: 4,
  scopes: 3,
  spend: { used: "418k", cap: "1.2M" },
  vetoRate: "14%",
  interruptsToday: 2,
  breakers: "closed",
};

export const CHATS = [
  { id: "c1", title: "Why did doc-sync get vetoed", when: "09:12", group: "Today", preview: "the check was too loose" },
  { id: "c2", title: "Tighten the content facts file", when: "08:40", group: "Today", preview: "every number needs a source line" },
  { id: "c3", title: "Add the CRM action tool", when: "Tue", group: "This week", preview: "class write_external, gated" },
  { id: "c4", title: "Alert triage rewrite", when: "Tue", group: "This week", preview: "group by root cause, not message" },
  { id: "c5", title: "Budget caps per task", when: "Mon", group: "This week", preview: "250k doc-sync, 150k triage" },
  { id: "c6", title: "Interview: onboarding NEOP", when: "Jul 24", group: "Earlier", preview: "four tasks, each with a check" },
  { id: "c7", title: "Worktree isolation setup", when: "Jul 22", group: "Earlier", preview: "one lock per scope, in postgres" },
];

export const THREADS = {
  c1: [
    { who: "human", at: "09:12", text: "doc-sync passed its check last night but the PR touches three files I didn't expect. What happened?" },
    { who: "neop", at: "09:12", text: "The check passed. The verifier flagged it anyway.",
      log: "run 8c41 · doc-sync · 04:00 IST\n\nsuccessCheck   npm run docs:lint             exit 0\nverifier       3 files changed, 1 in scope   VETO\n\n  docs/api/auth.md          in scope\n  docs/api/sessions.md      not requested\n  docs/api/billing.md       not requested" },
    { who: "neop", at: "09:12", text: "The agent did the scoped work, then rewrote two route docs it decided were stale. Both edits are correct — they just weren't asked for. The PR is open, nothing merged." },
    { who: "human", at: "09:14", text: "so the check was too loose" },
    { who: "neop", at: "09:14", text: "Yes. docs:lint passes on any valid docs tree, so it can't tell scoped work from scope creep. This would fail the run instead:",
      log: "git diff --name-only main \\\n  | grep -qv '^docs/api/auth' && exit 1" },
    { who: "neop", at: "09:14", text: "Want me to write it into the contract?" },
  ],
  c2: [
    { who: "human", at: "08:40", text: "content-draft keeps inventing retention numbers. How do I stop that?" },
    { who: "neop", at: "08:40", text: "Point every numeric claim at one source file and refuse anything that isn't in it — then scan the copy before publish and fail on any figure that doesn't match a line." },
  ],
};

export const RUNS = [
  { id: "8c41", task: "doc-sync", at: "04:00", dur: "6m 12s", tok: "84.2k", verdict: "vetoed",
    note: "3 files changed, 1 in scope. Out-of-scope edits correct but unrequested.",
    check: "npm run docs:lint → exit 0", actions: ["read ×14", "edit ×3", "bash ×6", "open_pr"] },
  { id: "7b09", task: "content-draft", at: "10:00", dur: "11m 40s", tok: "142.8k", verdict: "awaiting",
    note: "Five drafts ready. Publishing is irreversible and needs your call.",
    check: "5 files in content/queue → exit 0", actions: ["read ×9", "write ×5", "ask_human"],
    gate: { cls: "publish_public", ask: "Publish the week's five drafts on the proposed schedule?", opts: ["Publish all five", "Publish 1–3 only", "Hold, I'll edit"] } },
  { id: "7a55", task: "outreach", at: "09:30", dur: "3m 02s", tok: "31.4k", verdict: "awaiting",
    note: "Draft reply to the partnerships thread. External email can't be unsent.",
    check: "draft exists → exit 0", actions: ["read ×4", "write ×1", "ask_human"],
    gate: { cls: "send_external_email", ask: "Send the drafted reply to the partnerships thread?", opts: ["Send it", "Send after I edit", "Don't send"] } },
  { id: "6f2d", task: "alert-triage", at: "08:30", dur: "4m 55s", tok: "48.1k", verdict: "verified",
    note: "9 error groups, 2 new. Top cause: Redis pool exhaustion on /session/start.",
    check: "ops/triage/2026-07-30.md non-empty → exit 0",
    actions: ["read ×22", "bash ×8", "spawn_subagent ×3", "post_internal"] },
  { id: "5e88", task: "doc-sync", at: "04:00", dur: "5m 41s", tok: "76.9k", verdict: "verified",
    note: "Two routes drifted, both corrected. PR #2214.",
    check: "npm run docs:lint → exit 0", actions: ["read ×11", "edit ×2", "open_pr"] },
  { id: "4d10", task: "alert-triage", at: "20:30", dur: "2m 18s", tok: "12.0k", verdict: "failed",
    note: "Trace export returned empty. Breaker at 1 of 2.",
    check: "triage file non-empty → exit 1", actions: ["read ×3", "bash ×4"] },
  { id: "3c77", task: "weekly-report", at: "18:00", dur: "—", tok: "22.6k", verdict: "running",
    note: "Pulling last week's run ledger.", check: "pending", actions: ["read ×6", "bash ×2"] },
];

/* Quick Build mock registry — a trimmed mirror of registry/ for zero-backend mode. */
export const QB_TOOLS = [
  { name: "read_brand_facts", cls: "read_internal", rev: true, taint: "trusted", egress: [], secrets: [],
    does: "Read the client's ground truth: facts.md and brand.md.",
    body: "## When to use\n\nBefore drafting anything, and again before claiming anything numeric." },
  { name: "draft_post", cls: "write_draft", rev: true, taint: "trusted", egress: [], secrets: [],
    does: "Write post copy into the queue directory.",
    body: "## When to use\n\nProducing candidate copy. Drafts are cheap." },
  { name: "publish_post", cls: "publish_public", rev: false, taint: "trusted", egress: ["broker.internal"], secrets: ["SOCIAL_BROKER_TOKEN"],
    does: "Publish finished copy to a social channel.",
    body: "## Irreversibility\n\nA deleted post is still a screenshotted post." },
  { name: "read_inbox", cls: "read_external", rev: true, taint: "untrusted", egress: ["broker.internal"], secrets: ["MAIL_BROKER_TOKEN"],
    does: "Read messages from a shared inbox.",
    body: "## The thing to understand\n\n**Its output is written by strangers.**" },
];

export const QB_TEMPLATES = [
  { id: "marketing", ver: "3.0.0", required: ["read_brand_facts", "draft_post"], optional: ["publish_post"],
    forbidden: ["read_inbox"], groundTruth: ["brand.md", "facts.md"],
    does: "Drafts, schedules and publishes content. Never invents a number.",
    body: "## Why inbox access is forbidden\n\nThis template can hold `publish_post`, which is irreversible." },
  { id: "coding", ver: "1.0.0", required: ["draft_post"], optional: [], forbidden: ["read_inbox", "publish_post"],
    groundTruth: [], does: "Edits code inside a worktree until the checks are green.",
    body: "## Charter\n\nSmall diffs. The reviewer's attention is the scarcest resource." },
];

export const TICKS = [
  { h: 0, v: "verified" }, { h: 4, v: "vetoed" }, { h: 4, v: "verified" },
  { h: 6, v: "verified" }, { h: 8, v: "verified" }, { h: 9, v: "awaiting" },
  { h: 10, v: "awaiting" }, { h: 12, v: "verified" }, { h: 14, v: "verified" },
  { h: 18, v: "running" }, { h: 20, v: "failed" }, { h: 22, v: "verified" },
];

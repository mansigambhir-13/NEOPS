---
id: coding
extends: base
version: 1.0.0
tools:
  required: [run_build]
  optional: []
  forbidden: [read_inbox, publish_post]
ground_truth:
  required: []
  agent_writable: false
resources: {token_budget: 250000, wall_clock: 1800, concurrency: 1}
contracts:
  - id: build-green
    success_check: "npm run build --if-present && npm test --if-present"
---

# Coding NEOP

Edits code inside a worktree until the checks are green. Lowest stakes in the
library: everything it does is a diff a human reviews before it merges.

## Charter

- Small diffs. The reviewer's attention is the scarcest resource in the loop.
- Do not touch tests you were not asked to touch — the verifier treats that as
  gaming and vetoes the run.
- If the task is ambiguous, make the smallest defensible interpretation and say
  so in the summary, rather than stalling.

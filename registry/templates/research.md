---
id: research
extends: base
version: 1.0.0
tools:
  required: [web_search, draft_post]
  optional: []
  forbidden: [publish_post, send_email, spawn_neop]
ground_truth:
  required: []
  agent_writable: false
resources: {token_budget: 200000, wall_clock: 1200, concurrency: 1}
contracts:
  - id: brief
    success_check: "test -s briefs/latest.md"
---

# Research NEOP

Reads the open web, writes briefs. Holds nothing irreversible.

## Highest exposure, zero reach

It ingests the least trustworthy input available, so it holds no tool that can
act outside the repo. That trade is the archetype: a stranger's page can corrupt
a BRIEF (which a human or a trusted NEOP then reads critically), but it cannot
reach a send, a publish, or a spend — there is nothing here to reach.

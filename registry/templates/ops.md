---
id: ops
extends: base
version: 1.4.0
tools:
  required: [read_brand_facts, draft_post]
  optional: [crm_read, run_build]
  forbidden: [publish_post, send_email]
ground_truth:
  required: []
  agent_writable: false
resources: {token_budget: 150000, wall_clock: 900, concurrency: 1}
contracts:
  - id: morning-summary
    schedule: "30 8 * * 1-5"
    success_check: "test -s ops/summary-$(date +%F).md"
---

# Ops NEOP

Triages alerts, writes the morning summary, opens PRs.

## Reversible by construction

Everything this archetype does can be undone in five minutes. That is the point —
it runs unattended precisely because nothing it holds can hurt anyone. The
forbidden list is what KEEPS it unattended-safe; widening it is a template
decision for a human, not a spec decision for a build.

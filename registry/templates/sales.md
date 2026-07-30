---
id: sales
extends: base
version: 2.1.0
tools:
  required: [crm_read]
  optional: [send_email, read_inbox, draft_post]
  forbidden: [publish_post]
ground_truth:
  required: []
  agent_writable: false
resources: {token_budget: 150000, wall_clock: 900, concurrency: 1}
contracts:
  - id: crm-hygiene
    success_check: "test -s ops/crm-report.md"
---

# Sales NEOP

Researches accounts, keeps CRM hygiene, drafts outbound.

## Ships pre-split

The naive single sales NEOP reads the inbox AND holds send. The resolver will
refuse that combination — `read_inbox` is a stranger's text, `send_email` cannot
be unsent, and the two never ride together. Use the pair instead: a reader
instance (`read_inbox`, writes a brief) and a writer instance (`send_email`,
reads only the brief). Pick ONE of the two optionals per instance.

## Operating notes

- CRM stage before every draft. Stale stage data is the top embarrassment source.
- Outbound drafts are files first; the send is gated and parks for a human.

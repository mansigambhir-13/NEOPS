---
name: crm_read
version: 1.0.0
action_class: read_internal
reversible: true
taint: trusted
secrets: [CRM_TOKEN]
egress: [crm.internal]
impl: ./impl/crm-read.ts
params:
  entity: {type: enum, values: [account, contact, deal]}
  query: {type: string}
---

# crm_read

Read accounts, contacts and deal stage.

## When to use

Before any outbound. Stale stage data is the top cause of embarrassing sends.

## When not to use

To bulk-export. This tool answers questions; it does not build lists to leave the
building. If a task needs an export, that is an operator decision, not a query.

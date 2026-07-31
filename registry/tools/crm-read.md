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

## Dev fixture

| account | contact | deal | stage | last_touch | note |
|---|---|---|---|---|---|
| Globex | dana@globex.example | Globex renewal | negotiation | 2026-07-28 | pricing objection open |
| Initech | sam@initech.example | Initech pilot | proposal | 2026-07-14 | STALE — no touch in 17 days |
| Umbrella | kai@umbrella.example | Umbrella expansion | closed_won | 2026-07-30 | handoff to CS pending |
| Hooli | ada@hooli.example | Hooli starter | discovery | 2026-06-30 | STALE — no touch in 31 days, stage unchanged |

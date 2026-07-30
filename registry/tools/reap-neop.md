---
name: reap_neop
version: 1.0.0
action_class: workspace_write
reversible: true
taint: trusted
secrets: []
egress: []
impl: runtime:reap_neop
params:
  slug: {type: string, desc: "<client>/<slug>"}
---

# reap_neop

Stop a NEOP and remove its worktree. The spec stays — a reaped NEOP can be
re-spawned; reaping is cleanup, not deletion.

## When to use

The NEOP finished its purpose, or it is misbehaving and the operator asked. A
failed run's worktree is retained by the runner for post-mortem regardless.

## When not to use

To silence a NEOP whose runs keep failing. That's the circuit breaker's job, and
a tripped breaker is information the operator should see, not tidy away.

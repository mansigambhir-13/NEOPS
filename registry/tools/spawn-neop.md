---
name: spawn_neop
version: 1.0.0
action_class: workspace_write
reversible: true
taint: trusted
secrets: []
egress: []
impl: runtime:spawn_neop
params:
  spec: {type: string, desc: "path to the spec.md you wrote"}
---

# spawn_neop

Boot a NEOP from a spec: resolve its template against the registry, pin tool
versions, create its worktree, and register it in the fleet.

## When to use

After the spec is written and its ground truth exists. Spawning is reversible —
`reap_neop` stops it and the worktree is retained for post-mortem — which is why
this is not a gated action.

## When not to use

- The requirement is still fuzzy. A spec you would rewrite tomorrow is a spec you
  should not spawn today; ask the human the one question that unfuzzes it.
- To "test" a template. That is `neop dev`, which stubs irreversible tools; a
  spawned NEOP with live tools is not a test bench.

## Refusals you should expect

| condition | message |
|---|---|
| required ground truth missing | `ground truth missing: <files>` |
| template resolution fails | the resolver's own message (taint, forbidden, unknown tool) |
| slug already spawned | `already running — reap it first` |

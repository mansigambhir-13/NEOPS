---
name: list_neops
version: 1.0.0
action_class: read_internal
reversible: true
taint: trusted
secrets: []
egress: []
impl: runtime:list_neops
params: {}
---

# list_neops

List the fleet: every spec under `neops/` and every live worktree, with template,
owner, and pinned versions.

## When to use

Before spawning (does this NEOP already exist?), and when the operator asks what
is running. `git worktree list` is the same inventory at a lower level.

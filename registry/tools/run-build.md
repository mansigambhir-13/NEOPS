---
name: run_build
version: 1.0.0
action_class: test_run
reversible: true
taint: trusted
secrets: []
egress: []
impl: builtin:bash
params:
  command: {type: string, desc: "build or test command, runs in the worktree"}
---

# run_build

Run the project's build or tests inside the worktree.

## When to use

After every substantive edit, before claiming anything works. The successCheck
will run it anyway — running it yourself first is how you avoid a veto.

## When not to use

- To fetch anything from the network. Egress is not what this tool is for.
- To touch files outside the worktree; the gate denies it and audits the attempt.

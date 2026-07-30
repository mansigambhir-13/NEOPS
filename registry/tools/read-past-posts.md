---
name: read_past_posts
version: 1.0.0
action_class: read_internal
reversible: true
taint: trusted
secrets: []
egress: []
impl: builtin:read_file
params:
  path: {type: string, desc: "content/published/..."}
---

# read_past_posts

Read the last weeks of published copy.

## When to use

Before drafting. Repeating an angle is the most common complaint a content
operation gets; the cure is thirty seconds of reading.

## When not to use

As a source of facts. Published copy inherits its numbers from the `facts.md`
that existed at publish time — the current `facts.md` is the only source now.

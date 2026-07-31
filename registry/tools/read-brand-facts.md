---
name: read_brand_facts
version: 1.0.0
action_class: read_internal
reversible: true
taint: trusted
secrets: []
egress: []
impl: builtin:read_file
path_prefix: ground-truth
params:
  path: {type: string, desc: "ground-truth/facts.md or ground-truth/brand.md"}
---

# read_brand_facts

Read the client's ground truth: `facts.md` (every number that may appear in copy)
and `brand.md` (voice, banned phrases, positioning).

## When to use

Before drafting anything, and again before claiming anything numeric. If the
number is not in `facts.md`, it does not exist for you.

## When not to use

Never skip it because you "remember" the facts from earlier in the session. The
file is the memory; your recollection is not.

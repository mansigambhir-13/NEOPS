---
name: read_registry
version: 1.0.0
action_class: read_internal
reversible: true
taint: trusted
secrets: []
egress: []
impl: builtin:read_file
params:
  path: {type: string, desc: "registry/INDEX.md first, then specific tool/template docs"}
---

# read_registry

Read the tool and template library.

## When to use

Always start with `registry/INDEX.md` — one line per tool, cheap to load. Read a
full tool or template doc only for the two or three candidates you are actually
considering. That is the whole discovery protocol; there is no search engine and
none is needed.

## When not to use

Do not re-read files you have already read this session to "double-check" — the
registry does not change under a running Foreman (you boot from a pinned ref).

---
name: draft_post
version: 1.0.0
action_class: write_draft
reversible: true
taint: trusted
secrets: []
egress: []
impl: builtin:edit_file
params:
  path: {type: string, desc: "content/queue/<date>/<slug>.md"}
  body: {type: string}
---

# draft_post

Write post copy into the queue directory. A draft is a file; nothing leaves the
machine.

## When to use

Producing candidate copy. Drafts are cheap — write more than you need and let the
human pick.

## When not to use

- The path is outside `content/queue/`. Drafts live in the queue, nowhere else.
- You are tempted to put a placeholder number in the copy "to fix later". A draft
  with an unsourced number is not a draft, it is a liability with a delay.

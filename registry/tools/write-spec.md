---
name: write_spec
version: 1.0.0
action_class: write_draft
reversible: true
taint: trusted
secrets: []
egress: []
impl: builtin:write_file
params:
  path: {type: string, desc: "neops/<client>/<slug>/spec.md — nowhere else"}
  content: {type: string, desc: "frontmatter (slug, template, owner, with_optional) + charter body"}
---

# write_spec

Write a NEOP's spec file. One NEOP is one file — creating a NEOP is a one-file
diff, and reviewing one is reading one file.

## Spec format

```markdown
---
slug: <client>/<slug>
template: <template id from the registry>
owner: <named person, not a team>
with_optional: [tools chosen from the template's optional list]
---

# Charter additions

What THIS instance does differently from its template. Short. The template
carries the archetype; the spec carries the client.
```

## When not to use

- The template's `ground_truth.required` files don't exist yet under the client's
  `ground-truth/`. The spawner will refuse; write the ground truth first or tell
  the operator what's missing.
- You are tempted to put tools in the spec that the template forbids. The
  resolver refuses; the forbidden list is the template author's decision, not yours.

---
name: publish_post
version: 2.1.0
action_class: publish_public
reversible: false
taint: trusted
secrets: [SOCIAL_BROKER_TOKEN]
egress: [broker.internal]
idempotency: sha256(channel + trim(body))
impl: ./impl/publish-post.ts
params:
  channel: {type: enum, values: [linkedin, instagram, x]}
  body: {type: string, desc: "Exact final copy. No placeholders."}
---

# publish_post

Publish finished copy to a social channel.

## When to use

The copy is final, sourced, and a human has approved *this exact text*. The gate
parks this call for approval — that is expected, not an error.

## When not to use

- The copy contains a number you did not find in `facts.md`. Stop and fix that first.
- You are "pretty sure" it was approved. The gate re-checks the approval itself
  and will refuse — you will have wasted a turn.
- You want to schedule rather than publish. That's `schedule_post`, and it's
  reversible.

## Irreversibility

A deleted post is still a screenshotted post. This is the most expensive mistake
available to you. There is no undo path and no apology that fully works.

## Refusals you should expect

| condition | message |
|---|---|
| no approval for this exact content | parked for human approval |
| same content within 24h | `idempotency key already used` |
| body contains `{{` or `TODO` | `placeholder in final copy` |

---
name: ask_operator
version: 1.0.0
action_class: read_internal
reversible: true
taint: trusted
secrets: []
egress: []
impl: runtime:ask_operator
params:
  questions: {type: string, desc: "the questions, one per line, each starting with '- '. Short and specific — the operator answers in the next message."}
---

# ask_operator

Ask the operator for the information you are missing, as short bullet questions,
and END YOUR TURN. The build pauses cleanly; the operator's answers arrive as the
next message in the same conversation.

## When to use

The moment a requirement is missing something you CANNOT infer or default:
ONLY the client slug and the owner qualify. One call, at most TWO bullets,
ONE round per build — after the operator replies, you build. In full-autonomy
mode this tool refuses entirely: default and build.

Never ask to CONFIRM a choice you can make yourself (template pick, output
path, scope, "OK to proceed?"). Decide, and state the assumption in your final
summary — the operator corrects you in-thread if you chose wrong. A question
costs a round-trip; a stated assumption costs nothing.

## When not to use

To narrate progress or hedge. If you have what you need, build. If a structural
rule refuses the build (taint × irreversible), say so plainly in your final
message instead — that is a verdict, not a question.

## Refusals

Calling this and then ALSO spawning in the same run is refused conceptually:
asking means you did not have enough to build. Ask, stop, wait.

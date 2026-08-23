# AI limitations and safety

Requirement 9 of the brief asks for this explicitly. Edit it to match what you
actually build — the version below describes the base as shipped.

## What the agent can do

- Hold a real-time spoken conversation and be interrupted
- Remember what was said earlier in the same session
- Look up reference information from a defined internal source
- Create a structured case from the conversation
- Hand the conversation to a human with full context

## What it cannot do

- Give legal, medical, financial, or emergency advice
- Make or confirm any official decision
- Access anything outside the conversation and its declared tools
- Remember anything across sessions — state dies when the call ends
- Verify the identity of the person speaking

## Where its information comes from

`lookup_service_info` in `lib/tools.ts`, and nothing else. Anything the agent
says that did not come from that tool is model output, and the prompt requires
it to be flagged as such.

## When it asks before acting

`create_case` is the only write. The prompt requires the agent to read the key
details back and get an explicit yes before calling it. Escalation is
non-destructive and does not require confirmation.

## When it escalates

- The user asks for a person
- The request needs authorised human judgement
- `lookup_service_info` returns `found: false` on something material
- The agent is not confident

Escalation carries a context summary so the user does not repeat themselves.

## When it is uncertain

It is instructed to say so plainly and offer a human, rather than fill the gap.
This is a prompt-level guarantee, not an enforced one — a model can still be
confidently wrong.

## When a tool fails

`app/api/llm/route.ts` catches the error and returns a structured failure to
the model with an instruction to tell the user the action did not go through
and offer to retry or escalate. The agent does not silently swallow it.

## Residual risks

- Prompt-level safety can be talked around. There is no output classifier.
- ASR errors on names, numbers, and addresses propagate into created cases.
  Read-back before confirmation is the only mitigation.
- The in-memory store has no access control. Anyone who knows a channel name
  can read its cases via `/api/cases`.
- Barge-in thresholds tuned in a quiet room will misfire in a loud one.

---
name: blast-radius
description: >-
  Trace the full effect of a change in KKT before making it. Activate whenever
  editing lib/game/, lib/tools.ts, lib/agent-config.ts, lib/env.ts, an
  app/api/ route, a riddle, an audio filename, or an env var — and any time a
  change looks like a one-liner. Names the specific places in this repo that
  fail *silently* when one end of a contract moves.
---

# Blast radius

A one-line change in this repo can go wrong in three places at once and none of
them will throw. `tsc` passes, the page renders, and the failure shows up as the
host talking nonsense on stage. This skill is the checklist for finding the other
ends of a contract *before* editing, not after.

## The rule

Before the edit, state — out loud, in the response — three things:

1. **Who reads this.** Grep for it. Not "probably nothing else"; the actual list.
2. **Which of the seams below it crosses.** Each seam has its own failure mode.
3. **What would prove it still works.** `npm run check` is the floor, not the
   ceiling. Say which specific thing you would look at.

Then edit. If the answer to (1) is longer than expected, say so before writing
code rather than discovering it halfway.

Skip nothing on the grounds that the change is small. The dangerous changes here
are *all* small: a renamed field, a different filename, one extra env var.

## The seams, and what breaks silently at each

### 1. `publicView()` — the wire format

[`lib/game/state.ts`](../../../lib/game/state.ts) `publicView()` is the single
shape that reaches every client. Consumers: `app/api/room/route.ts`,
`app/api/room/[code]/{route,join,action,events}.ts`, [`lib/tools.ts`](../../../lib/tools.ts),
and [`scripts/engine-check.ts`](../../../scripts/engine-check.ts).

Adding a field is safe. **Renaming or removing one is not**: the three consoles
(`components/host-console.tsx`, `phone-console.tsx`, `stage-view.tsx`) read it
through [`lib/use-room.ts`](../../../lib/use-room.ts), and a missing field reads
as `undefined` — which renders as an empty badge, not an error.

### 2. The LLM tool contract

Three things must agree, in three files:

- the schema in [`lib/tools.ts`](../../../lib/tools.ts) (`get_state`,
  `select_wire`, `cut_wire`, `wrong_answer`, `get_hint`, `defer_wire`,
  `grant_lifeline`, `phone_a_friend`),
- the `case` in the same file's dispatch,
- the prompt in [`lib/llm.ts`](../../../lib/llm.ts) that tells the host these
  tools exist.

Rename a tool in one place and the model calls a tool that no longer exists. The
proxy returns an error object, the model apologises to the room, and nothing in
the logs says "you renamed a tool."

Also: **the server owns the clock and the wire state** (AGENTS.md). If a change
lets the model compute anything instead of being told it, that is the bug, not a
style question.

### 3. The SSE stream and its resume contract

[`app/api/room/[code]/events/route.ts`](../../../app/api/room/[code]/events/route.ts)
emits sequenced events; [`lib/use-room.ts`](../../../lib/use-room.ts) reconnects
with `?since=<seq>` and falls back to polling after three tick-less seconds.
Touching either end means checking both: a broken resume looks like a frozen
clock, and the polling fallback will hide it well enough to pass a short test.

Never add a `setInterval` that decrements a counter. The clock is derived in
`secondsLeft()`.

### 4. Audio filenames — three producers, one consumer that cannot complain

The hint path is built in [`lib/game/riddles.ts`](../../../lib/game/riddles.ts)
as `/audio/hints/<riddle id>_h1.wav`. That same string is:

- **written** by [`scripts/render-hints.ts`](../../../scripts/render-hints.ts),
- **checked** by [`app/api/health/route.ts`](../../../app/api/health/route.ts),
- **fetched by Vobiz** via `<Play>` from [`lib/game/lifeline.ts`](../../../lib/game/lifeline.ts).

Vobiz **skips audio it cannot fetch, without erroring**. So changing a riddle
`id`, a filename, or a directory turns a lifeline into 45 seconds of dead air on
a live call. If you touch any of these, re-run `npm run render:audio` and read
the clip counts in `/api/health` — the counts are the only signal.

### 5. Vobiz callback URLs

`answer_url`, `ring_url`, `hangup_url` are built in
[`lib/game/lifeline.ts`](../../../lib/game/lifeline.ts) and served by
`app/api/vobiz/{answer,ring,hangup}/route.ts`. Moving or renaming one of those
routes leaves the other end pointing at a 404, which Vobiz treats as silence.

### 6. Agora agent config

[`lib/agent-config.ts`](../../../lib/agent-config.ts) is the ConvoAI join
payload. A wrong or invented field name does not error — the agent joins and
simply does not do the thing. Per AGENTS.md: **never write Agora or Vobiz fields
from memory.** Invoke the `agora` skill or fetch the docs, and treat
`docs/AGORA-NOTES.md` and `docs/VOBIZ.md` as the record of what has actually been
verified. Two settings that fail silently as a pair: `advanced_features.enable_rtm`
and `parameters.data_channel: "rtm"` — one without the other means no transcripts.

### 7. A new env var is never one line

Adding one means touching, at minimum:

- [`.env.example`](../../../.env.example) — or nobody else can run it,
- [`render.yaml`](../../../render.yaml) `envVars` — or it is missing in
  production, where the failure is silent,
- [`lib/env.ts`](../../../lib/env.ts) if it needs a default or derivation,
- [`app/api/health/route.ts`](../../../app/api/health/route.ts) if its absence
  should be loud,
- the env table in [`README.md`](../../../README.md).

`PUBLIC_BASE_URL` is the cautionary tale: it is derived from `RENDER_EXTERNAL_URL`
on the host, and a stale tunnel value in a deployed process passes every check
while pointing the host at a room that does not exist.

### 8. Game rules

[`lib/game/store.ts`](../../../lib/game/store.ts) is 863 lines of rules, and
[`scripts/engine-check.ts`](../../../scripts/engine-check.ts) is the scripted
round that asserts the humiliating ones: the clock only moves when it should, a
wire cannot be cut twice, a failed lifeline refunds in full, phone numbers are
gone by the end. **Change a rule → change the assertion.** If a rule change makes
`check:engine` pass unchanged, either the rule was untested or the change did
nothing; find out which.

Answer checking is semantic, never string matching.

## Verification floor

`npm run check` (`tsc --noEmit` + `check:engine`), then `/api/health` for clip
counts, base-URL source, and serving host. Both exist specifically to make the
silent failures loud. Neither covers the browser flow — host creates room, QR
resolves, three phones join, stage renders — so if the change touches that path,
say plainly that it is untested rather than implying `check` covered it.

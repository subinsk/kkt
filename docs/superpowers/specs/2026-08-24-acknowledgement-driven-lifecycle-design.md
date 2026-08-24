# Acknowledgement-driven lifecycle

**Date:** 24 Aug 2026
**Status:** design approved in chat, awaiting spec review
**Scope:** host speech, user speech + attribution, Peer Talk, Phone a Friend

## The problem

Four subsystems do asynchronous work the room can see or hear. Only one of them
knows whether that work actually happened.

| | States | Ack source | Deadline + fallback |
|---|---|---|---|
| Phone a Friend | `idle→dialing→ringing→connected→done\|failed` + `since` | Vobiz webhooks | **yes** — `lifelineLimit()`, swept by `sweepLifeline()` |
| Peer Talk | a boolean plus a local `pending` flag | HTTP 200, after the mic has already flipped | **no** — `act()` has no timeout |
| Host speech | none — a string overwritten in place | **none** | `ONSET_TIMEOUT_MS`, which then reveals anyway |
| User speech | none | none | none |

The lifeline is the model. This design generalises it to the other three.

### What that costs today

The speech bubble renders a *prediction*. `host_said` is emitted by the LLM proxy
(`app/api/llm/route.ts:285`) before the text is handed to Agora, so everything
downstream — Agora's own playback queue, filler insertion, `/speak` preemption,
barge-in, TTS failure — can change what comes out of the speaker with nothing
reporting back. The observed symptom is the host saying one thing while the
bubble shows another, and sentences going missing from one side or the other.

Concretely:

- **Audio with no text.** Filler phrases (`lib/agora-rest.ts:235`) are chosen by
  Agora and never pass through our proxy. `llm.failure_message` likewise. The
  proxy's own catch-block line (`app/api/llm/route.ts:298`) is streamed to TTS
  without an `emit`.
- **Text never fully spoken.** `speak()` defaults to `priority: "INTERRUPT"`
  (`lib/agora-rest.ts:93`) and `hostSay()` does not override it
  (`lib/game/host-speak.ts:28`), so all three lifeline lines cut the host off
  mid-sentence. Barge-in at 160ms does the same, and `FINISHED_FRACTION = 0.5`
  guesses where the truncation landed.
- **Text never rendered.** `hostSaid` is a single `useState` slot with no queue
  (`components/stage-view.tsx:225`, `phone-console.tsx:289`,
  `host-console.tsx:34`), so a line arriving while another is displayed
  overwrites it before it renders — while Agora's side plays both, in order.
  Identical consecutive text is a silent no-op, because the change detector at
  `speech-bubble.tsx:87` is a string compare and the prompt explicitly tells the
  host to re-ask a question after being interrupted. SSE reconnect replays missed
  events in a burst and only the last survives.
- **Five independent clocks.** The reveal is paced by
  `SPOKEN_WORDS_PER_SECOND = 2.3` gated on `AGENT_SPEAKING_LEVEL = 0.06`,
  measured per client. Projector, host console and three phones each run their
  own copy against their own level reading.
- **Attribution is dead code.** `attribute()` in `lib/game/attribution.ts` is
  never called. All four `setSpeaker()` sites hardcode `contested: false`, so
  `game.contested` is permanently false and the host's contested-floor branch
  (`lib/agent-config.ts:376`) can never fire. The phones sample at 30Hz and POST
  every 200ms into a store nothing reads. The reason is structural:
  `attribute()` takes `(code, startMs, endMs)` and nothing in the system knows
  when a human's turn began or ended.

That last point is why this is one design and not two. The missing abstraction is
the same on both sides of the conversation: an utterance with a start, an end,
and an acknowledgement.

## Decisions taken

1. **Observe and reconcile, not a server-owned outbound queue.** Agora keeps
   owning playback order — its own docs guarantee filler words and LLM responses
   are "played in the order they arrive". We track each utterance and render only
   what the acks confirm. Nothing is ever delayed and barge-in stays instant.
2. **Fail closed on "did he say it at all", with one retry.** No start ack by the
   deadline means no subtitle, then one re-speak, then move on. A quiz host
   repeating a question sounds natural, so at-least-once delivery costs nothing
   in character even when the ack was merely lost rather than the audio.
3. **Fail open on "did we hear the end".** Once `speaking` is acked the room
   demonstrably heard him, so a lost END ack must not trigger a retry — that
   would duplicate audible speech.
4. **Deadlines are per state and derived, never one global number.**
5. **Acks are idempotent by `(turnId, status)`**, so any number of reporters is
   harmless. No leader election.

## Design

### 1. One vocabulary

A new ledger on `Game`, beside `lifeline`, using the same `status` + `since` field
discipline so the sweep functions read alike.

```ts
type UtteranceOrigin =
  | "greeting"   // Agora TTSs greeting_message directly, no LLM turn
  | "turn"       // an LLM turn through our proxy
  | "scripted"   // /speak — the lifeline lines
  | "filler"      // Agora chose it; we only ever observe
  | "failure"     // llm.failure_message, or the proxy's own fallback
  | "unattributed"; // heard, and nothing on our side chose it — a divergence

type UtteranceStatus =
  | "pending"      // we hold the text; nothing heard yet
  | "speaking"     // ack: TTS started for this turn
  | "ended"        // ack: turn END
  | "interrupted"  // ack: barge-in, carrying the real truncation point
  | "lost"         // deadline passed with no ack
  | "retrying"     // re-spoken once, linked to the original
  | "abandoned";   // retried and still lost — the game moves on

type Utterance = {
  id: string;                  // room-scoped, monotonic
  origin: UtteranceOrigin;
  text: string;                // what we intended to say
  spoken: string | null;       // what the transcript says actually came out
  status: UtteranceStatus;
  since: number;               // when the status last changed
  attempts: 1 | 2;
  retryOf: string | null;
  turnId: number | null;       // Agora's turn_id, once known
  wire: WireColor | null;      // what it was about, so a stale retry is refused
};
```

`spoken` is separate from `text` on purpose. They are the two halves of the
divergence check, and for an `interrupted` utterance only `spoken` reached the
room.

### 2. Deadlines and fallbacks

Mirrors `lifelineLimit()`:

```ts
function utteranceLimitMs(u: Utterance): number {
  switch (u.status) {
    case "pending":
    case "retrying": return startDeadlineFor(u.origin);
    case "speaking": return spokenDurationMs(u.text) * END_SLACK;
    default:         return 0;   // terminal
  }
}
```

Note the units. `lifelineLimit()` returns **seconds**; `utteranceLimitMs()`
returns **milliseconds**, because speech is timed in hundreds of milliseconds and
calls are timed in tens of seconds. The `Ms` suffix is the whole defence against
mixing them, so it is mandatory on every constant in this family.

The two waits differ in kind, so they are computed differently.

**Start deadline** is roughly constant — TTS time-to-first-byte — but not the
same cold as warm:

| Origin | Deadline | Why |
|---|---|---|
| `greeting` | 6000ms | Published the instant Agora accepts the join; the agent still has to connect and Sarvam still has to return first audio. Same reasoning that set `ONSET_TIMEOUT_MS`. |
| everything else | 2500ms | Mid-round the pipeline is warm. |

Both are seed values. `AGENT_METRICS` reports real per-module TTS latency, so
once it is wired these become measured numbers rather than estimates. That is the
intended end state; the constants are the interim.

**End deadline** is proportional to the line: `spokenDurationMs(text) * 1.6`.
`spokenDurationMs` is already biased slow, and 1.6 keeps a forty-word line from
being declared lost while he is still speaking it.

**Fallback transitions**, one per state:

| Deadline hit in | Condition | Then |
|---|---|---|
| `pending` / `retrying` | attempt 1, not stale, floor quiet | → `retrying`; re-`/speak` with `priority: "APPEND"` |
| `pending` / `retrying` | attempt 2 | → `abandoned` |
| `pending` / `retrying` | stale | → `abandoned`; retry refused |
| `pending` / `retrying` | floor not quiet | hold, re-evaluate next sweep |
| `speaking` | always | → `ended` (fails open) |

Two predicates, defined once so they cannot drift:

- **stale** — the `wire` this utterance was registered against is no longer
  `game.activeWire`, or `game.phase !== "running"`.
- **floor quiet** — no `UserTurn` is currently in `listening`.

### 2a. Registered versus observed utterances

Not every utterance can start at `pending`, and the distinction matters enough to
be structural rather than a special case.

- **Registered** (`greeting`, `turn`, `scripted`, and the proxy's own fallback
  line) — we hold the text before it is spoken, so the record is created at
  `pending` and has a start deadline, a retry, and a divergence check.
- **Observed** (`filler`, and Agora's `llm.failure_message`) — Agora chooses
  these and speaks them without our proxy ever seeing them. There is nothing to
  register in advance, so the record is created at `speaking` on first sight in
  the transcript. It has **no start deadline and is never retried** — there is no
  intended text to compare against and nothing was lost.

So a `speaking` ack whose `turnId` matches no `pending` record is not an error.
It is classified by matching its text against `FILLER_PHRASES` and
`failure_message`; anything matching neither is recorded with
`origin: "unattributed"` and counted as a divergence, which is precisely the
signal worth having — it means the host said something no part of our system
chose.

Three rules make the watchdog safe rather than merely present:

- **Forward-only.** A late ack for an `abandoned` utterance is recorded on the
  record and emitted as a divergence, never applied.
- **`retryOf` scopes acks.** An attempt-2 ack can never be credited to attempt 1.
- **No new timer.** `sweepUtterances(game)` is called from exactly where
  `sweepLifeline(game)` already is — `app/api/room/[code]/events/route.ts:109`
  plus every mutation. The clock stays derived from timestamps.

Do not retry into a shouting room. `interrupted` is a terminal ack rather than
`lost`, so barge-in cannot produce a retry loop, and the floor-quiet condition
above stops a `lost` line burning its single retry while people talk over it.

### 3. User turns and multiple speakers

A `UserTurn` ledger mirroring the above:

```ts
type UserTurnStatus = "listening" | "final" | "discarded" | "abandoned";

type UserTurn = {
  turnId: number;
  status: UserTurnStatus;
  startedAt: number;
  endedAt: number | null;
  text: string;
  playerId: string | null;   // from attribute()
  contested: boolean;
  confidence: number;
  source: "hold" | "level" | "uid" | "none";
};
```

`attribute(code, startedAt, endedAt)` is called on `final`, and `setSpeaker`
at last receives a real `contested`. That single call is what brings
`lib/game/attribution.ts` and the host's contested-floor prompt branch to life.

Watchdog: a `listening` turn that never finalises — stalled ASR, a phone dropping
mid-sentence — is `abandoned` at **6000ms**, which is twice the configured
`end_of_speech.max_wait_ms` of 3000. Agora should have closed the turn itself
long before; doubling it means this only fires when that genuinely did not
happen. Without it the floor never goes quiet again, which would block every
retry behind it.

Three multi-speaker bugs this addresses:

- **Self-echo eats real answers.** `isSelfEcho` matches on containment
  (`attribution.ts:227`). When the room speaker leaks into three open mics *and*
  someone answers over it, both land in one ASR turn, the transcript contains the
  host's line, and the whole turn is discarded — the answer with it, silently,
  before it reaches the model (`app/api/llm/route.ts:169`). Fix: subtract the
  matched echo span and keep the remainder; discard only if what is left falls
  under the existing six-character floor.
- **Filler echo is attributed to a human.** `rememberAgentUtterance` is only
  called with LLM turn text (`app/api/llm/route.ts:276`), so Agora's fillers are
  never remembered and come back through the mics as a contestant's words.
  Observing fillers through the transcript closes this.
- **The echo filter should remember `spoken`, not `text`.** For an interrupted
  line only a prefix reached the room, so matching the full intended text can
  fall below the 0.6 trigram threshold and the echo leaks through.

`MIN_ENERGY`, `CONTESTED_RATIO` and `HOLD_BOOST` have never run against real
data, because nothing has ever called the function they live in. Treat all three
as unvalidated and tune them in the room, like the barge-in thresholds.

### 4. Peer Talk

`muted → requesting → live` (and back), plus `failed`. Two bugs close: `act()`
gains an `AbortSignal.timeout`, so a stalled tunnel cannot pin the button
forever; and `requesting` becomes a visible state, so the pill can never read
"live" while LIVE STATE tells the host the opposite. One retry, then revert and
say so on the handset.

### 5. Phone a Friend

Unchanged. It joins the shared vocabulary by documentation only — `sweepLifeline`
stays exactly as written, and gains nothing but the shared `act()` timeout.

### 6. The renderer stops guessing

`SpeechBubble` takes `{ id, text, status, spoken }` instead of a bare string.

- Keying the change detector on `id` rather than string identity kills the
  identical-repeated-line bug outright.
- `status` replaces the level threshold: `speaking` starts the reveal, `ended`
  finishes it, `interrupted` supplies the real truncation point — so
  `FINISHED_FRACTION`, and the reasoning about which mistake to make, is deleted.
- The renderer keeps only sub-second character pacing. If Sarvam supplies no word
  timings it still interpolates, but now between two known boundaries, so the
  error is bounded rather than accumulating.

### 7. Ack transport and degraded mode

Any client may report. Each subscribes to the ConvoAI events over RTM and POSTs
to `POST /api/room/[code]/ack` with `{ turnId, status, text, atMs }`. The server
owns every transition. Application is idempotent by `(turnId, status)`, so two
open `/stage` tabs are redundancy rather than a race.

Reporters heartbeat on the same route, so silence is distinguishable from a quiet
host. No heartbeat for `DEGRADE_AFTER_MS` (6000, against a 2000ms heartbeat
cadence) sets `degraded: true` on the ledger, published in `publicView()`. In
degraded mode the bubble reverts to today's estimate-on-level behaviour — fail
*open* — and the host console shows a badge. Fail closed is correct when acks
work; a silent blackout never is.

This is the one place the design deliberately keeps the old code path alive
rather than deleting it.

A room starts *in* degraded mode, because no reporter has checked in yet. That is
correct rather than a cold-start bug: the greeting is published the moment Agora
accepts the join, well before any client could have subscribed, so it falls back
to the estimate — exactly today's behaviour — and the ledger leaves degraded mode
on the first heartbeat.

## What this deletes

- `FINISHED_FRACTION` and the barge-in guess in `lib/subtitles.ts`.
- `host_said` / `agent_spoke` as the bubble's input, replaced by `utterance_*`
  events. All three consoles cut over in the same change.
- The permanent `contested: false` at all four `setSpeaker()` sites.

## Non-goals

- No server-owned outbound speech queue. Agora keeps playback order.
- No change to answer checking, which stays semantic.
- No webhook integration in this pass. `111 agent metrics` (to measure the start
  deadline) and `103 dialogue history` (post-round reconciliation) are the
  obvious follow-up. `112 turns finished` is doc-inconsistent — see
  `docs/AGORA-NOTES.md`, 24 Aug 2026.
- No word-level karaoke sync in this pass. It depends on two of the unverified
  items below, and `TEXT` mode already fixes *what* is shown, which is the bulk
  of the problem.

## Unverified before implementation

Each of these is an experiment, not a judgement call. None blocks the design; all
four change how much of it pays off.

1. **Does the transcript `uid` resolve per-player in a three-publisher channel?**
   AGENTS.md flags it as an hour-one experiment. If it does, level telemetry
   becomes a fallback nobody needs and `source: "uid"` is the normal path.
2. **Does Sarvam Bulbul supply word timings?** `enableRenderModeFallback` exists
   precisely because vendors may not.
3. **Is `ENABLE_AUDIO_PTS_METADATA` honoured by `agora-rtc-sdk-ng@4.24.7`?** The
   literal string is absent from the installed bundle; the `audio-pts` /
   `audioMetadata` plumbing is present.
4. **Does RTM need Signaling enabled in the Agora Console for this project?** The
   docs list it as a prerequisite. If it is not enabled and cannot be, the only
   fallback is `data_channel: "datastream"` with an undocumented payload — worse,
   and to be avoided.

## Staging

This is fourteen files and four subsystems, which is more than one sitting. It
decomposes cleanly into three steps, each of which leaves the repo working and
demonstrably better than before. The order is chosen so the riskiest external
dependency — RTM — is not blocking anything until step 2.

**Step 1 — the loud fixes, no new dependency.** `speak` priority default,
`trigger.fixed_time_config`, the proxy fallback line emitted and in Devanagari,
`act()` timeout, and an id on every utterance so identical text stops collapsing
and the burst-on-reconnect stops discarding lines. No RTM, no ledger. This alone
removes the lifeline guillotine and the two rendering bugs.

**Step 2 — the utterance ledger and the renderer.** `lib/game/utterances.ts`,
the ack route, `lib/rtm.ts`, the id-keyed status-driven bubble, degraded mode.
This is where sync actually gets fixed, and where the Console/Signaling
prerequisite lands.

**Step 3 — the human side.** `UserTurn`, the `attribute()` call that brings
attribution to life, the echo-span subtraction, real `contested`. Depends on
step 2's transport but on nothing else.

Each step carries its own slice of the test list below.

## Testing

`scripts/engine-check.ts` already drives the reveal machine with a synthetic
audio track. It gains a synthetic *ack* track, and assertions for the failures
that are currently unobservable:

- two lines arriving in quick succession both render
- an identical repeated line renders twice
- a lost start ack retries exactly once, then abandons
- a stale retry (wire changed) is refused
- a late ack after `abandoned` is recorded but not applied
- a `speaking` timeout fails open, and does not retry
- a `listening` user turn that never finalises is abandoned
- two overlapping speakers produce `contested: true`
- an echo-plus-answer transcript keeps the answer

`/api/health` gains per-round counts of unacked, abandoned and divergent
utterances, and reports `degraded`. Same spirit as the existing missing-MP3
check: make the silent failures loud.

## Files

| File | Change |
|---|---|
| `lib/game/state.ts` | `Utterance`, `UserTurn`, statuses, `utteranceLimitMs`, Peer state; `publicView()` gains both ledgers and `degraded` |
| `lib/game/utterances.ts` | **new** — the machine, `sweepUtterances`, `sweepUserTurns` |
| `lib/game/store.ts` | registration and transition call sites; real `contested` |
| `lib/game/attribution.ts` | echo-span subtraction; remember `spoken` |
| `app/api/room/[code]/ack/route.ts` | **new** — ack and heartbeat intake |
| `app/api/llm/route.ts` | register an utterance instead of `emit("host_said")`; emit the fallback line |
| `app/api/room/[code]/agent/route.ts` | register scripted and greeting utterances |
| `lib/agora-rest.ts` | `speak` priority default; `trigger.fixed_time_config` fix |
| `lib/rtm.ts` | **new** — the client-side subscription and reporter |
| `lib/subtitles.ts`, `components/stage/speech-bubble.tsx` | id-keyed, status-driven; delete `FINISHED_FRACTION` |
| `components/stage-view.tsx`, `phone-console.tsx`, `host-console.tsx` | drop local `hostSaid`, read the ledger |
| `lib/use-room.ts` | `act()` timeout |
| `scripts/engine-check.ts`, `app/api/health/route.ts` | the assertions and counters above |

## Blast radius

This crosses four of the seams the `blast-radius` skill names as silent failures:
the `publicView()` wire format, the SSE resume contract, the Agora agent payload,
and the audio cue the subtitle keys off. Invoke that skill before the first edit,
not after.

# Agora notes

Things the docs left ambiguous until somebody looked them up. Dated, so the next
session knows how stale it is. See `AGENTS.md` for the rule: never write Agora
from memory, fetch it.

## `llm.greeting_message` — 23 Aug 2026

Source: `POST /v2/projects/{appid}/join`,
<https://docs.agora.io/en/api-reference/api-ref/conversational-ai/join>
(fetched 23 Aug 2026; the `docs-md.agora.io` mirror 404s for this page, use
`docs.agora.io`).

- Type: string. **No documented maximum length.**
- It is **converted to speech by the TTS module directly** — it does *not* go
  through the LLM. So a greeting is deterministic: exactly the words you send are
  the words the room hears, with no turn spent and nothing invented.
- `greeting_audio_url` is a sibling field. If it is set, `greeting_message` is
  the fallback used when the audio fails to download or decode, and it is also
  what the system uses to estimate playback progress if the audio greeting is
  interrupted.

Why this mattered here: the whole opening — intro, rules, and the first riddle —
lives in `openingLine()` and rides in on `greeting_message`. That is only safe
because of the second bullet. If it went through the LLM, the rules would come
out differently at every rehearsal.

## Script: everything spoken is Devanagari — 23 Aug 2026

Bulbul runs with `target_language_code: hi-IN`. Handed Roman letters it
pronounces them **as English**, so "Paanch taar, chhe minute" comes out as a
phrasebook accent while "पाँच तार, छह मिनट" comes out clean. The riddles were
always Devanagari, which is exactly why they sounded right and every sentence
around them did not.

So the rule across the repo is: **spoken → Devanagari, displayed → Roman.**

| Text | Script | Why |
|---|---|---|
| `riddles.speak`, `riddles.hints`, `nearMiss` *values* | Devanagari | goes to TTS, via the host or via a pre-rendered WAV |
| `openingLine()`, `GREETING`, `failure_message`, outcome stingers | Devanagari | TTS'd verbatim, no model in the loop |
| everything the host says | Devanagari | the `# SCRIPT` block in `SYSTEM_PROMPT`, incl. English words spelled phonetically — लॉक, हिंट, फ़ोन अ फ्रेंड |
| `riddles.screen`, `WIRE_LABELS_HI`, all phone/projector UI | Roman | read with eyes, never spoken |
| `riddles.accept`, `nearMiss` *keys* | both | matched against what a contestant said, which can arrive in either |

Two couplings that fail silently if this drifts:

- `nearMiss` **keys** are substring-matched against the host's `wrong_answer`
  argument. The host now writes Devanagari, so a Roman-only key list matches
  nothing and every diagnostic hint quietly degrades to generic. Keep both
  scripts as keys.
- `hints[0]` is rendered straight to WAV for Phone a Friend, with no model to
  fix the script. `npm run check` asserts the whole bank is Latin-free.

**Still unknown:** whether a lone Latin word inside a Devanagari sentence (a
contestant's name from the join form, or the "On Air" button label) is read
cleanly. Both are deliberate and both are single tokens — listen for them in the
first rehearsal.

## `filler_words` phrases: 20 characters if non-Latin — 23 Aug 2026

Learned from a live `400`, not from the docs:

```
Invalid value at properties.filler_words.content.static_config.phrases:
Each phrase in filler_words.content.static_config.phrases containing CJK
or non-Latin characters must be at most 20 characters.
reason: InvalidFieldValue
```

The reference page for `POST /v2/projects/{appid}/join` documents only
"Maximum 100 filler words" and "Each filler word must not exceed 50 English
words" — it says nothing about this cap. **The 20-character rule is enforced but
undocumented.**

Two things that make it bite harder than it looks:

- It is a **whole-request rejection**. One over-long phrase 400s the entire
  `/join`, so the host never enters the room — it does not drop the phrase and
  carry on. On a projector thirty seconds before a demo it reads as "the game is
  broken".
- **Devanagari spends characters fast**, because matras are separate code
  points. "कंप्यूटर जी, जवाब दिखाइए..." is 27 characters and reads as four short
  words.

Phrases now live in `FILLER_PHRASES` in `lib/agent-config.ts`, all ≤16
characters, and `npm run check` measures every one of them.

Also confirmed on the same page, same date: no documented character limit on
`llm.greeting_message`, `llm.system_messages` or `llm.failure_message`.
`greeting_message` and `failure_message` support `{{variable_name}}` template
substitution. `greeting_audio_url` over 2048 bytes returns a 400. ASR and
interrupt keywords cap at 128 each.

## `/speak` interrupts by default — 24 Aug 2026

Source: `POST /v2/projects/{appid}/agents/{agentId}/speak`,
<https://docs.agora.io/en/api-reference/api-ref/conversational-ai/speak>
(fetched 24 Aug 2026).

| Field | Type | Required | Default |
|---|---|---|---|
| `text` | string | yes | — (max **512 bytes**) |
| `priority` | string | no | **`INTERRUPT`** |
| `interruptable` | boolean | no | `true` |

The documented wording, because the default is the dangerous one:

- **`INTERRUPT`** — "High priority. The agent immediately interrupts the current
  interaction to announce the message."
- **`APPEND`** — "Medium priority. The agent announces the message after the
  current interaction ends."
- **`IGNORE`** — "Low priority. If the agent is busy interacting, it ignores and
  discards the broadcast; the message is only announced if the agent is not
  interacting."

Why this matters here: `hostSay()` sends `interruptable: false` and no
`priority`, so all three lifeline lines take the `INTERRUPT` default and
**guillotine whatever sentence the host was in the middle of**. `interruptable`
protects the *incoming* line from the room; it does nothing for the line being
destroyed. Announcements that must land in order want `APPEND`.

512 bytes is not 512 characters. Devanagari spends three bytes per code point,
so the real ceiling is roughly 170 characters — comfortably above the lifeline
lines, but worth knowing before anything longer is sent this way.

## `data_channel` defaults to `datastream`, and the client docs are RTM-only — 24 Aug 2026

Source: `POST /v2/projects/{appid}/join`, same page as above; plus
<https://docs.agora.io/en/ai/build/handle-runtime-events/get-runtime-events>
and <https://docs.agora.io/en/ai/build/transcripts> (all fetched 24 Aug 2026).

`properties.parameters.data_channel` takes two values:

- `rtm` — "Use RTM transmission. This configuration takes effect only when
  `advanced_features.enable_rtm` is `true`."
- `datastream` — "Use RTC data stream transport." **This is the default.**

So the two flags in `buildAgentProperties` are doing something easy to
misread: setting `data_channel: "rtm"` routes agent events *away* from the RTC
data stream and onto the RTM channel. With no RTM client logged in, that means
transcripts, agent state and interrupt events are being published to a channel
nobody is on. It is not that they fail — they arrive somewhere we are not.

`datastream` looks like a shortcut to the same events over the RTC SDK we
already ship, but **there is no documented client parsing story for it**: the
"Client-side events" and "Display live transcripts" pages both instruct
`data_channel: "rtm"` and require RTM enabled for the project, and the client
toolkit only reads RTM. Treat `datastream` as UNVERIFIED — using it means
parsing an undocumented payload.

Also on the same pages: `parameters.enable_metrics` and
`parameters.enable_error_message` "only take effect when
`advanced_features.enable_rtm` is `true`".

## What the client actually receives — 24 Aug 2026

Source: <https://docs.agora.io/en/api-reference/api-ref/conversational-ai/client-toolkit/web>
(fetched 24 Aug 2026).

Transcript item (`ISubtitleHelperItem`):

```ts
{ uid: string; stream_id: number; turn_id: number;
  _time: number; text: string; status: ETurnStatus; metadata: T | null }
```

`ETurnStatus`: `IN_PROGRESS` (0), `END` (1), `INTERRUPTED` (2). That third value
is the one worth the whole integration — it is the authoritative answer to "was
he cut off, and where", which `FINISHED_FRACTION` in `lib/subtitles.ts`
currently guesses at with a coin-flip.

Events: `TRANSCRIPT_UPDATED`, `AGENT_STATE_CHANGED` (`idle | listening |
thinking | speaking | silent`, with `turnID` + `timestamp` + `reason`),
`AGENT_SPEAKING_CHANGED`, `AGENT_INTERRUPTED` (`{ turnID, timestamp }`),
`AGENT_METRICS`, `AGENT_ERROR`.

Two traps in the same reference:

- **`TRANSCRIPT_UPDATED` delivers the complete history every time.** Replace
  state, never append, or every turn is duplicated.
- **Word-level timing is not guaranteed.** `WORD` render mode needs
  `AgoraRTC.setParameter('ENABLE_AUDIO_PTS_METADATA', true)` called *before*
  `createClient()`, and setting it afterwards produces no error — the timing
  data simply never arrives. The config carries an `enableRenderModeFallback`
  flag (default `true`) precisely because "the server doesn't provide word-level
  timing data" is an expected case.

**UNVERIFIED, both to settle by experiment:** the literal string
`ENABLE_AUDIO_PTS_METADATA` does not appear in our installed
`agora-rtc-sdk-ng@4.24.7` bundle, though the `audio-pts` / `audioMetadata`
plumbing does; and whether Sarvam Bulbul supplies word timings at all is
unknown. `TEXT` mode needs no PTS and is enough to fix *what* is displayed —
only the sub-second sync depends on this.

## Filler words: wrong config key, and Agora has a playback queue — 24 Aug 2026

Source: <https://docs.agora.io/en/ai/build/shape-the-conversation/filler-words>
(fetched 24 Aug 2026).

The documented key is **`trigger.fixed_time_config.response_wait_ms`**,
confirmed identically in all four samples on the page (Python, TypeScript, Go,
REST). `buildAgentProperties` sends `trigger.config.response_wait_ms`, so our
1200ms is being **silently ignored** and fillers fire at the server default.
Note the asymmetry that caused this: `content` really does take
`static_config`, and `trigger` takes `fixed_time_config` — neither is plain
`config`.

Two behaviours stated on the same page:

- **"When multiple filler words or LLM responses are waiting to be played, they
  are played in the order they arrive."** Agora maintains its own outbound
  playback queue. Anything on our side that tracks what the host is saying has
  to observe that queue rather than assume one line at a time.
- Filler words "inherit the interruption mode setting from the global
  configuration in `turn_detection.config`".

Consequence for the transcript work: filler phrases are chosen by Agora, so they
are spoken without ever passing through our LLM proxy — which is why
`rememberAgentUtterance` never sees them and filler echo is not filtered.

## Webhooks: `112 turns finished` is doc-inconsistent — 24 Aug 2026

Source: <https://docs.agora.io/en/ai/build/handle-runtime-events/webhooks> and
<https://docs.agora.io/en/ai/build/handle-runtime-events/get-runtime-events>
(both fetched 24 Aug 2026).

The webhook event table lists `101` agent joined, `102` agent left, `103`
dialogue history, `110` agent error, `111` agent metrics, `201`/`202` call
state. The *other* page additionally lists **`112 turns finished`**, which does
not appear in that table. **Treat `112` as UNVERIFIED** — do not build a
per-turn server-side acknowledgement on it without confirming it fires.

Also documented there: agent state changes and interrupt events are
**client-path only** — webhooks cannot supply them. So a purely server-side ack
route cannot drive a subtitle; it can only audit one after the fact. Webhooks
need Console notification setup and a secret, signatures are HMAC-SHA1
(`Agora-Signature`) and HMAC-SHA256 (`Agora-Signature-V2`) over the raw body,
and Agora's own guidance is to make handling idempotent "because retries can
happen".

## Transcripts over RTM: three things that each fail silently — 24 Aug 2026

All three found by `npm run check:browser`, which exists because none of them
produce an error anywhere. Verified against a live agent.

**1. The agent's token needs RTM privileges, not just RTC.**

The `/join` reference says it under `enable_rtm`: *"make sure the token includes
both RTC and RTM privileges. When an agent joins an RTM channel, it reuses the
token specified in the `token` field."* Built with
`RtcTokenBuilder.buildTokenWithUid`, that token carries RTC only — so the agent
joins the channel, speaks, and can never join RTM to publish what it said.
`/join` returns 200 regardless and `GET /agents/{id}` reports `RUNNING`.

Use `RtcTokenBuilder.buildTokenWithRtm(appId, cert, channel, account, role,
tokenExpire, privilegeExpire)`, which is what the FAQ linked from that page
recommends. `account` is the agent's uid as a string, matching `agent_rtc_uid`.

**2. The client toolkit does not subscribe the RTM client to the channel.**

`ConversationalAIAPI.subscribeMessage(channel)` attaches
`addEventListener("message")` to the RTM engine and never calls
`rtmClient.subscribe(channel)` — readable in `dist/index.js`. It treats the RTM
lifecycle as the app's job, the same way it treats `rtcClient.join()`. Without
our own `subscribe()`, the listener is armed on a channel the client never
joined: login succeeds, nothing errors, no message ever arrives.

Order matters, and the RTM SDK states it: *"You need to listen to events before
calling, such as `message` ... otherwise you may miss some events."* So
`AgoraVoiceAI.init()` first, then `rtmClient.subscribe(channel)`.

**3. In `TEXT` render mode there is no in-progress transcript.**

A sentence arrives once, already finished, with `status: END (1)`. `IN_PROGRESS`
never appears. So a transcript alone cannot tell you *when* the agent started
talking — only what it said. For the timing, use `AGENT_STATE_CHANGED`, which
carries `turnID` alongside `state: "speaking"`; `AGENT_SPEAKING_CHANGED` is a
bare boolean with no turn id and cannot be correlated.

`agent_rtm_uid` is worth setting explicitly. It appears in the `/join` request
samples but has **no entry in the parameter list**, so there is no documented
default and no documented behaviour when omitted.

## Transcript `uid` does NOT identify which contestant spoke — 24 Aug 2026

The question AGENTS.md flagged as an hour-one experiment, now answered by
observation with two contestants seated and a live agent:

```
{uid:296439 turn:3 status:1 obj:assistant.transcription}   <- the agent's own uid
{uid:0      turn:2 status:1 obj:user.transcription}        <- every human
```

The agent's items carry its real `agent_rtc_uid`. **Human items carry `uid: 0`** —
the field separates the agent from "the humans" collectively and says nothing
about which of them was talking.

So `lib/game/attribution.ts` is not decoration and never becomes decoration: mic
level telemetry from each handset is the *only* signal for who spoke, and
`source: "uid"` in its `Attribution` type is unreachable. `metadata.object`
(`assistant.transcription` vs `user.transcription`) is the reliable way to tell
agent turns from human ones — more reliable than the uid comparison, which only
works because the agent's uid happens to be non-zero.

## SAL cannot arbitrate a multi-contestant floor — 25 Aug 2026

Checked because it is the obvious candidate for "which contestant spoke", and it
is not one. Source: the `/join` and `/update` references, fetched 25 Aug 2026.

`properties.advanced_features.enable_sal` + `properties.sal` (**Beta**), two
modes:

- **`locking`** — "The agent locks onto the speaker, blocking 95% of ambient
  human voices and noise." Seamless mode picks the speaker automatically from
  whoever "speaks loudly and clearly at the beginning of a conversation".
- **`recognition`** — voiceprint identification. Identifies speakers and passes
  the target through `vpids` in the `metadata` field to the LLM (requires
  `llm.vendor: "custom"`, which we already are). **Only one voiceprint URL is
  supported**, registered via `sample_urls` as a 16kHz 16-bit mono `.pcm` of
  10–15 seconds with at least 8 seconds of speech, under 2MB. The name `unknown`
  is reserved.

Neither fits a three-contestant quiz. `locking` would silence two of the three.
`recognition` distinguishes one enrolled voice from everyone else, not Rahul from
Priya from Amit.

**And the lock cannot be moved.** The `/update` request body accepts only
`properties.token`, `properties.llm.params` and `properties.mllm.params` — `sal`
is not updatable at runtime. So a lock is fixed for the life of the agent and
cannot be handed to a different contestant per turn.

What this project does instead is the same idea in our own state: an **exclusive
floor**, enforced in `setPeerMode`, where going live unpublishes everybody else.
One publisher means one possible speaker, re-decided on every button press, with
names we already hold — no voiceprints, no Beta, no session-long lock. See the
"exclusive floor" section of `npm run check`.

## What the client actually gets, measured — and why exact subtitle sync is not reachable — 25 Aug 2026

Measured against a live agent with `enable_rtm: true`, `data_channel: "rtm"`,
`enable_metrics: true`, `enable_error_message: true`, the RTM channel subscribed
with both `withMessage` and `withPresence`, and every toolkit event registered.
Repeated across several runs.

**1. `TRANSCRIPT_UPDATED` is the only client event that fires reliably.**

Handlers were registered for every event the toolkit exposes, each logging on
entry. Across several runs nothing but transcripts arrived — no
`AGENT_STATE_CHANGED`, no `AGENT_SPEAKING_CHANGED`, no `AGENT_INTERRUPTED`, no
`AGENT_METRICS`, no `AGENT_TURN_FINISHED`.

**Corrected the same day:** a later run *did* produce a `speaking` state change,
so these are **unreliable rather than absent**. Do not build on them. That
matters because `AGENT_STATE_CHANGED` is the documented source of "the agent
started speaking, on turn N" and the only event carrying a `turnID` — so there is
no dependable turn-start signal from Agora at all. Register it, use it when it
comes, and never require it.

**2. The transcript arrives once per turn, at the turn's END.**

`status` is always `1` (END). `IN_PROGRESS` never appears in `TEXT` mode. The
opening greeting is a paragraph, so its transcript lands **forty-odd seconds**
after the host starts talking — the transcript describes a line that has already
finished.

**3. Sarvam supplies no word timings, and asking for them is worse.**

`WORD` render mode, with `ENABLE_AUDIO_PTS_METADATA` set before `createClient`
and `enableRenderModeFallback` both defaulted and set explicitly: no `words[]`
data ever arrived, **and the agent transcript stopped arriving entirely** while
user transcripts kept coming. Three runs. So WORD is not a trade of accuracy for
risk here — it is strictly worse than TEXT.

### The consequence for subtitles

From Agora's client channel we learn *what he said*, *after he said it*, and
nothing about when he started or how far through he is. So a subtitle cannot be
driven from it. **Exact word-level sync is not reachable on this stack.**

What *is* exactly synchronised is the audio itself. `IRemoteAudioTrack.getVolumeLevel()`
is read off the very stream the room is hearing, so it gives an exact start edge
and an exact end edge. The division of labour that follows:

| Question | Source | Accuracy |
|---|---|---|
| When did he start? | audio level | exact |
| When did he stop? | audio level | exact |
| What are the words? | our own pre-TTS text, confirmed by the transcript | exact |
| Was he cut off, and where? | transcript `status: INTERRUPTED` + `spoken` | exact |
| Where is he *within* a line? | interpolation | **approximate** |

Only the last row is approximate, and its error is bounded by the length of a
line. Two things reduce it:

- **Measure the rate instead of assuming it.** A completed turn gives a real
  duration for a known word count, so `wordsPerSecond` is learned per room rather
  than hardcoded at 2.3. This removes the systematic component, which on a
  forty-second line is most of the visible error.
- **Shorten the line.** The residual is proportional to the interval between two
  exact edges. Speaking one sentence per turn instead of one paragraph puts an
  exact edge every few seconds, which makes the interpolation imperceptible. This
  is the remaining lever and it is a change to how we drive TTS, not to how we
  render.

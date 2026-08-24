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

# Kaun Katega Taarpati — Multiplayer Voice Game Show Recipe (Next.js)

A **three-player Hinglish game show** driven by one Agora Conversational AI
agent. Three people scan a QR code, join on their phones, and become
contestants. The host — an original character on a Sarvam voice — asks them
paheliyan. Each correct answer cuts one of five wires. Six minutes on the clock.
Stuck? **Phone a Friend** places a real PSTN call, and a voice on the other end
reads the hint on loop until the lifeline expires.

## What makes this recipe different

Most voice-agent recipes are one user, one agent, and the model is trusted to
remember what happened. None of those hold here:

| | Typical recipe | This recipe |
| --- | --- | --- |
| Publishers | one user | **three phones**, one agent, `remote_rtc_uids: ["*"]` |
| State | lives in the model's context | **server-authoritative**, re-injected every turn |
| Clock | the model counts, or there isn't one | **derived from timestamps**, never ticked |
| Tools | run in the LLM endpoint or on MCP | run inside the **LLM proxy**, which also owns the state |
| Escalation | none | **outbound PSTN call** to a human off-channel |

Distinct from `recipe-agent-custom-llm`: that recipe shows you how to point
Agora at your own OpenAI-compatible endpoint. This one shows you what to *do*
with the seat once you have it — inject ground truth, execute tools against it,
and refuse whatever the model got wrong.

Distinct from `recipe-agent-rpg`: there, Agora cloud orchestrates tools on an
MCP server. Here the tool loop runs inside the proxy, one hop earlier, so the
same request that runs a tool also decides what the model is allowed to believe.

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- An [Agora](https://console.agora.io/) project with an App Certificate, plus
  RESTful API credentials (Console → Developer Toolkit → RESTful API)
- A [Sarvam](https://dashboard.sarvam.ai/) API key — one key covers both ASR
  (Saaras) and TTS (Bulbul)
- An LLM provider key. [Groq](https://console.groq.com/) is the default.
  **Agora does not host an LLM** — this is mandatory, not optional.
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  — Agora's cloud must reach `/api/llm`, so localhost is not enough
- *(Optional)* A [Vobiz](https://console.vobiz.ai/) account and a number you
  own, for the Phone a Friend lifeline

## Run It

```bash
# 1. Install
npm install

# 2. Credentials
cp .env.example .env.local     # then fill it in

# 3. Start the server and renew the tunnel in one step
npm run dev
```

`npm run dev` starts Next **and** renews the cloudflared quick tunnel, writes
the new hostname into `PUBLIC_BASE_URL`, and verifies the server answers through
it. These are deliberately one command: a quick tunnel's hostname changes on
every start, and a stale `PUBLIC_BASE_URL` breaks the LLM proxy and every
telephony webhook **without erroring anywhere**.

Open <http://localhost:3000> — the landing page runs the pre-flight check and
opens a room. Then:

- **Projector / laptop** → `/stage/<code>` — the 3D set, the wires, the chyron
- **Each phone** → `/join/<code>` — scan the QR, enter a name, become a contestant
- **Operator** → `/host/<code>` — the host console and live programme feed

### Before every run

```bash
npm run check          # typecheck + the engine rule assertions
npm run render:audio   # re-render hint clips and outcome stingers via Sarvam
```

and open `/api/health`, which reports what is missing. Both exist for one
reason: this architecture has an unusual number of failures that are *silent*. A
hint MP3 that is not on disk makes the telephony provider skip the audio, so
Phone a Friend becomes forty-five seconds of dead air on a live call, with no
error in any log.

## Environment variables

| Variable | Required | Default | Notes |
| --- | :---: | :---: | --- |
| `NEXT_PUBLIC_AGORA_APP_ID` | Yes | — | Must be `NEXT_PUBLIC_` — the browser needs it to join the channel |
| `AGORA_APP_CERTIFICATE` | Yes | — | Console → Project Management |
| `AGORA_CUSTOMER_ID` | Yes | — | Console → Developer Toolkit → RESTful API |
| `AGORA_CUSTOMER_SECRET` | Yes | — | Same page. Without these the agent cannot be started |
| `PUBLIC_BASE_URL` | Yes (local) | derived | **Public** origin Agora fetches `/api/llm` from. Cannot be `localhost`. On Render/Vercel it is derived from the host |
| `SARVAM_API_KEY` | Yes | — | One key drives both ASR and TTS |
| `SARVAM_TTS_SPEAKER` | | `abhilash` | Male: `abhilash`, `karun`, `hitesh`. Female: `anushka`, `manisha`, `vidya`, `arya` |
| `SARVAM_ASR_LANGUAGE` | | `unknown` | `unknown` enables auto-detection — **this is the Hinglish lever** |
| `LLM_PROVIDER` | | `groq` | `groq` (OpenAI-compatible) or `anthropic` |
| `LLM_UPSTREAM_URL` | | Groq | `https://api.groq.com/openai/v1/chat/completions` |
| `LLM_API_KEY` | Yes | — | Agora hosts no model. Without this the host cannot think |
| `LLM_MODEL` | | `llama-3.3-70b-versatile` | Needs tool calling. Avoid `gpt-oss-*` on Groq — no parallel tool calls |
| `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN` | | — | Phone a Friend. Without them the lifeline refunds itself, visibly |
| `VOBIZ_FROM_NUMBER` | | — | E.164 **without** the plus, and a number you actually own |
| `INTERRUPT_DURATION_MS` | | `160` | Barge-in. Retune in the real room at real noise levels |
| `SILENCE_DURATION_MS` | | `380` | End-of-speech. Broadcast pacing, not chat pacing |

Full annotated list: [`.env.example`](../../.env.example).

## Architecture

```
  Phones (QR + name)          Projector / laptop            This server
  ──────────────────          ──────────────────            ───────────
  mic publish            ◄── SSE + POST ──►  Three.js set   Next.js
  Peer Talk toggle                           Agora RTC recv  ├─ game state (authoritative)
  level telemetry                            room speakers   ├─ derived clock
  wire pips                                  chyron          ├─ attribution
  Phone a Friend                                             ├─ /api/llm  (custom LLM endpoint)
        │                                                    ├─ tool handlers
        │                                                    ├─ 5 riddles + hints
        └────────── inbound PSTN call ◄──────────────────────┴─ telephony client

              Agora Conversational AI Engine
              ASR: Sarvam Saaras → LLM: /api/llm → TTS: Sarvam Bulbul
```

Agora's cloud calls `/api/llm` on every user turn. That endpoint — not the
model — is where the game actually lives.

## The three patterns worth stealing

### 1. The custom LLM endpoint is the spine

Agora streams whatever the LLM emits straight into TTS. Point `llm.url` at a
provider directly and a tool call reaching Agora is **read aloud as gibberish**.
Sitting in the middle means the proxy can:

1. call the model itself, non-streaming, so tool calls are trivial to read
2. execute tool calls against real server state
3. feed results back and loop, up to `MAX_TOOL_ROUNDS` (5)
4. stream only the final prose onward as OpenAI-shaped SSE chunks

```ts
// lib/agora-rest.ts — the field the whole build rests on
llm: {
  url: `${publicBaseUrl()}/api/llm?room=${encodeURIComponent(channel)}`,
  api_key: optional("PROXY_SHARED_SECRET", "unused"),  // Agora just needs non-empty
  system_messages: [{ role: "system", content: systemPrompt }],
  max_history: 40,
  greeting_message: greeting,
  params: { model: optional("LLM_MODEL", "..."), stream: true },
}
```

The cost is real: a tool round adds latency before the agent speaks. Agora's
`filler_words` covers it — and in a game show under a countdown, that latency
reads as *suspense* rather than lag, which is a free pass on the thing that
usually damages voice demos.

### 2. The server owns the clock, and it is derived, never ticked

There is no `setInterval` decrementing a counter anywhere. `secondsLeft()`
computes from `startedAt`, accumulated pause time, and the sum of penalties.
Every reader — phones, projector, model, host console — derives the same number
from the same facts, and hot reload cannot desync it.

The model is **told** the state every turn and never computes it. A language
model asked to count seconds will invent a number, confidently, in front of an
audience. So every request to `/api/llm` gets a freshly-built `LIVE STATE`
system message: clock, wire statuses, who is live, what was just guessed, and
the answer key for the active wire. It is regenerated per request rather than
cached, because a stale clock is worse than no clock.

### 3. One live mic collapses the hardest problem in multiplayer voice

Every phone has a **Peer Talk** toggle, on by default. While it is on, that
contestant's mic is not published to the channel — the host genuinely cannot
hear them, and they argue about the answer through the air, like people in a
room do. To speak to the host, you switch Peer Talk **off**.

When exactly one contestant is live, *whatever the ASR heard is that person*.
Attribution becomes arithmetic rather than inference. It also means one open mic
instead of three, so most of the room-speaker echo problem stops existing.
Level-telemetry attribution survives as the fallback for when two people go live
at once — which is now a deliberate act, and makes the arbitration beat clearer
rather than muddier.

## What You Get

- A **three-publisher voice agent**: one agent, `remote_rtc_uids: ["*"]`, three
  phones, and a wildcard that also covers late joiners and reconnects.
- **Semantic answer checking, never string matching** — the model judges whether
  what was said *means* the answer, and the server refuses any cut that is not
  for the active wire.
- **Eight tools** the host acts through, all backed by authoritative state:

| Tool | When the host calls it |
| --- | --- |
| `get_state` | Unsure what is true. Cheap — call it instead of guessing |
| `select_wire(color)` | Contestants choose a colour; returns the riddle to ask |
| `cut_wire(color, answered_by)` | Someone said something that *means* the answer key |
| `wrong_answer(answer_text, player_id)` | Costs time; returns why that guess was wrong, for the next hint |
| `get_hint(color)` | Costs time, so permission must have been asked and granted |
| `defer_wire(color)` | Park a wire for later. Free |
| `grant_lifeline(player_id)` | Unlocks the Phone a Friend button. Does not dial |
| `phone_a_friend(player_id)` | Places a real PSTN call. Once per game |

- **A human escalation path off the channel**: the lifeline dials a real phone,
  and the friend hears a pre-rendered hint clip on loop, with explicit pauses
  between plays, until the lifeline expires.
- **Barge-in tuned for a room**, not a headset — VAD start-of-speech, semantic
  end-of-speech, and a 3.5s silence timeout that follows broadcast pacing.
- **RTM transcripts and metrics**, which need *both*
  `advanced_features.enable_rtm: true` and `parameters.data_channel: "rtm"`.
  One without the other fails silently.

## How It Works

1. The projector opens a room. Phones scan the QR and `POST /api/room/<code>/join`.
2. `GET /api/agora/token` mints an RTC token per phone; each publishes its mic.
3. `POST /api/room/<code>/agent` mints a second token for the agent uid and calls
   Agora's `/join`, handing over the whole ASR/LLM/TTS config — including
   `llm.url` pointed back at this server.
4. A contestant switches Peer Talk off and speaks. Agora runs Sarvam Saaras with
   `language: "unknown"`, so "nariyal" or "coconut" or half of each all
   transcribe.
5. Agora `POST`s the turn to `/api/llm`. The proxy prepends a fresh `LIVE STATE`
   block and calls the upstream model with the eight tool definitions.
6. The model emits e.g. `cut_wire("red", "p2")`. The proxy executes it against
   the store, which validates it, applies the rule, advances the clock, and emits
   an SSE event that every client renders.
7. The tool result goes back to the model, which narrates the outcome. Only that
   prose is streamed on to Agora, which runs Sarvam Bulbul and plays it into the
   room.
8. For lines that must not be improvised — the lifeline announcement, the closing
   line after the outcome stinger — the server calls `POST /agents/<id>/speak`
   directly with `interruptable: false`, skipping the model entirely.

## Repo Map

| Path | What |
| --- | --- |
| `app/api/llm/route.ts` | **The custom LLM endpoint** — state injection + tool loop |
| `lib/agora-rest.ts` | ConvoAI join config, `speak`, `interrupt`, filler words |
| `lib/agent-config.ts` | Who the host is, and the `LIVE STATE` block |
| `lib/tools.ts` | The eight tool schemas and their implementations |
| `lib/llm.ts` | Upstream adapters (OpenAI-compatible / Anthropic) |
| `lib/game/state.ts` | Data model, derived clock, public wire format |
| `lib/game/store.ts` | Every rule and mutation, plus the SSE event bus |
| `lib/game/riddles.ts` | Five riddles, one per wire, with hints and near-misses |
| `lib/game/attribution.ts` | Level telemetry, `contested` detection, self-echo filter |
| `lib/game/lifeline.ts` | Phone a Friend orchestration |
| `lib/vobiz.ts` | Outbound PSTN call, hint-loop Voice XML |
| `components/stage/` | The 3D set: room, table, wire panel, host, contestants |
| `components/phone-console.tsx` | Contestant handset, including Peer Talk |
| `components/host-console.tsx` | Operator console with a live programme feed |
| `app/api/health/route.ts` | Pre-flight check for the silent failures |

## Troubleshooting

Every entry here is a failure that produces **no error anywhere**. That is why
the health check exists.

| Problem | Cause | Fix |
| --- | --- | --- |
| Host joins but never speaks | `PUBLIC_BASE_URL` is stale — the tunnel restarted | `npm run dev` renews and verifies it; never paste a hostname by hand |
| Host talks but no transcript appears | Only one of the two RTM flags is set | Set **both** `advanced_features.enable_rtm` and `parameters.data_channel: "rtm"` |
| Agent is rejected at `/join` | `agent_rtc_uid` sent as an int | It is a **string** |
| Only one phone is heard | `remote_rtc_uids` enumerated, or a single entry | Use the wildcard **array**: `["*"]` |
| Host reads a tool call aloud as gibberish | `llm.url` points at a provider, not at your proxy | Point it at `/api/llm` and execute tools yourself |
| Phone a Friend rings, then dead air | Hint MP3 unreachable — unreachable audio is **skipped silently** | `npm run render:audio`, then check `/api/health` |
| Lifeline call refuses to place | `from` is not a number you own, or carries a `+` | `from` is E.164 **without** the plus |
| Filler words never fire | Wrong config key — `trigger` takes `fixed_time_config`, `content` takes `static_config` | Neither is plain `config`; the wrong key is accepted and discarded |
| Host guillotines his own sentence | `speak` left at Agora's `priority: "INTERRUPT"` default | Default to `APPEND`; use `/interrupt` when you actually mean to cut |
| Host states a wrong countdown | The model was asked to compute the clock | Inject it. The server owns the clock, always |

## More Docs

- [README.md](../../README.md) — the project, its staging, and the design reasoning
- [AGENTS.md](../../AGENTS.md) — engineering rules, including "never write Agora from memory"
- [docs/AGORA-NOTES.md](../AGORA-NOTES.md) — Agora fields verified at runtime, with dates
- [docs/VOBIZ.md](../VOBIZ.md) — telephony fields verified at runtime, with dates
- [docs/DEPLOY.md](../DEPLOY.md) — why this needs a long-lived Node process, not serverless
- [kaun-katega-taarpati-spec.md](../../kaun-katega-taarpati-spec.md) — the game design spec

# Kaun Katega Taarpati

**Paanch taar. Chhe minute. Lock kiya jaye?**

A projector shows a game-show set. Three people scan a QR code, join on their
phones, and become contestants. **Amitabh bhai** — an original character on a
Sarvam voice — asks them Hinglish paheliyan. Each correct answer cuts one of five
wires. Six minutes on the clock. Stuck? **Phone a Friend** places a real phone
call, and a voice on the other end reads the hint on loop until the lifeline
expires.

Built for Build with Agora, Track 4. Design spec: [kaun-katega-taarpati-spec.md](kaun-katega-taarpati-spec.md).
Engineering rules: [AGENTS.md](AGENTS.md).

---

## How it fits together

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
        └────────── Vobiz inbound call ◄─────────────────────┴─ Vobiz client

              Agora Conversational AI Engine
              ASR: Sarvam Saaras → LLM: /api/llm → TTS: Sarvam Bulbul
```

**The custom LLM endpoint is the spine.** Agora calls `/api/llm` instead of
calling a model provider directly, which is the only way to (a) inject
authoritative game state into every single turn and (b) actually execute tool
calls — Agora streams model output straight to TTS, so a tool call reaching Agora
would just be read aloud as gibberish.

**The server owns the clock and the wires.** The model is *told* the state every
turn and never computes it. A language model asked to count seconds will invent a
number, confidently, in front of judges.

---

## The staging

A corporate meeting room, shot from **behind the contestants**.

```
                    ┌─────────────────────────┐        ┌──────────┐
                    │ 1 ══════════════════════│        │ 00:05:12 │  wall clock
                    │ 2 ══════════════════════│        └──────────┘
   flipchart        │ 3 ══════════════════════│
      │             │ 4 ══════════════════════│              window
      │             │ 5 ══════════════════════│                │
      │             └─────────────────────────┘                │
      │                    wire panel                          │
                                                               │
                        ( Amitabh bhai )   ← faces the camera
                     ╭───────────────────────╮
                    ╱                         ╲
                   │      oval table, hole     │
                    ╲                         ╱
                     ╰───────────────────────╯
              (  P1  )      (  P2  )      (  P3  )   ← backs to camera
                 ▓            ▓             ▓          task chairs
                        ↑ camera here
```

Putting the camera in the contestants' seats makes the projector a *first-person*
view of the game rather than a diorama of one — the audience is at the table. It
also forces the five wires onto the wall behind the host: anything on the table
would be hidden behind three heads.

The same scene renders in the host console, from the same component, so the
operator is never judging a force-cut against a different picture than the room.

## Two ideas worth knowing before reading the code

### Peer Talk

Every phone has a **Peer Talk** toggle, on by default. While it is on, that
contestant's mic is not published to the channel — the host genuinely cannot hear
them, and they argue about the answer through the air, like people in a room do.
To speak to Amitabh bhai you switch Peer Talk **off**.

This collapses the hardest problem in the original design. When exactly one
contestant is live, *whatever the ASR heard is that person* — attribution becomes
arithmetic rather than inference. It also means one open mic instead of three, so
most of the room-speaker echo problem stops existing. Level-telemetry attribution
survives as the fallback for when two people go live at once, which is now a
deliberate act and makes the arbitration beat clearer, not muddier.

### The clock is derived, never ticked

There is no `setInterval` decrementing a counter anywhere. `secondsLeft()`
computes from `startedAt`, accumulated pause time, and the sum of penalties. Every
reader — phones, projector, model, host console — derives the same number from the
same facts, and hot reload cannot desync it.

---

## Running it

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run dev
```

Agora's cloud and Vobiz both have to reach this server, so localhost is not
enough:

```bash
npx cloudflared tunnel --url http://localhost:3000
# put the tunnel URL in PUBLIC_BASE_URL
```

> Restarting the tunnel changes the URL, which **silently** breaks the LLM proxy
> and every Vobiz webhook. Nothing errors. Re-check it before every rehearsal.

Then open <http://localhost:3000> — the landing page runs the pre-flight check and
opens a room.

### Before every rehearsal

```bash
npm run check          # typecheck + 49 engine rule assertions
npm run render:audio   # re-render hint clips and outcome stingers via Sarvam
```

and open `/api/health`, which reports what is missing. Both exist for one reason:
this project has an unusual number of failures that are *silent*. A hint MP3 that
is not on disk makes Vobiz skip the audio, so Phone a Friend becomes forty-five
seconds of dead air on a live call, with no error anywhere.

---

## Keys you need

| Key | Where | Without it |
|---|---|---|
| `NEXT_PUBLIC_AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | Console → Project Management | Nobody can join the channel |
| `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET` | Console → Developer Toolkit → RESTful API | The agent cannot be started |
| `SARVAM_API_KEY` | dashboard.sarvam.ai | No voice at all — one key covers ASR and TTS |
| `LLM_API_KEY` | Groq (default) | The host cannot think |
| `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER` | console.vobiz.ai | Phone a Friend fails — and refunds, visibly |
| `PUBLIC_BASE_URL` | your tunnel | Agora cannot reach `/api/llm` |

**Agora does not host an LLM** — a provider key is mandatory, not optional. Groq
is the default because this is a voice game show under a countdown, so
time-to-first-token is what the room actually perceives. An Anthropic adapter is
built and sits behind `LLM_PROVIDER` as the quality failover: flip one variable,
restart, no code change.

`VOBIZ_FROM_NUMBER` must be a number you actually **own** — Vobiz rejects a `from`
you have not purchased, so an auth token alone is not enough to place the call.

---

## Layout

| Path | What |
|---|---|
| `lib/game/state.ts` | Data model, derived clock, public view |
| `lib/game/store.ts` | Every rule and mutation, plus the event bus |
| `lib/game/riddles.ts` | Five fixed riddles, one per wire, with hints and near-misses |
| `lib/game/attribution.ts` | Level telemetry, `contested` detection, self-echo filter |
| `lib/game/lifeline.ts` | Phone a Friend orchestration |
| `components/stage/` | The 3D set: room, table, wire panel, host, contestants, effects |
| `components/stage-view.tsx` | Projector — 3D plus the broadcast chyron |
| `components/phone-console.tsx` | Contestant handset, including Peer Talk |
| `components/host-console.tsx` | Host console, with a live programme feed |
| `lib/agent-config.ts` | Who Amitabh bhai is, and the LIVE STATE block |
| `lib/agora-rest.ts` | ConvoAI join config, `speak`, `interrupt` |
| `lib/vobiz.ts` | Outbound call, hint-loop Voice XML |
| `lib/llm.ts` | Upstream adapters (OpenAI-compatible / Anthropic) |
| `lib/tools.ts` | The tool surface the host acts through |
| `app/api/llm/route.ts` | The custom LLM endpoint — state injection + tool loop |
| `_legacy/` | Earlier scaffold from a different concept, kept for reference |

---

## Consent

Phone numbers are entered by contestants themselves, behind an explicit consent
checkbox, held in memory only, and dropped when the round ends — asserted by the
engine check. They never appear in the public view sent to any client, and they
leave the server only as a Vobiz `to` field.

# Architecture

## The shape of it

```
Browser                    Next.js server                 Agora cloud
-------                    --------------                 -----------
mic ──audio──────────────────────────────────────────────▶ RTC channel
                                                                │
  ◀──────────────────────────────────────────audio────────── agent
                                                                │
  ◀───transcript (RTC data stream)─────────────────────────────┘
                                                                │
        GET  /api/agora/token  ◀── mints RTC token              │
        POST /api/agent/start  ──▶ joins agent to channel ──────┘
        POST /api/agent/stop   ──▶ removes agent
                                                                │
        POST /api/llm  ◀────── Agora calls this every turn ─────┘
              │
              ├──▶ OpenAI-compatible LLM (tools declared)
              ├──▶ executeTool(...)  → lib/store.ts
              └──── streams prose back as SSE → Agora TTS
```

## The one non-obvious decision

`llm.url` points at **our own** `/api/llm`, not at OpenAI.

Agora's Conversational AI Engine pipes whatever the LLM streams straight into
TTS. If you point it at OpenAI directly and the model emits a tool call, nobody
executes it — the agent just goes quiet. Sitting in the middle means we:

1. call the model ourselves (non-streaming, so tool calls are easy to read),
2. execute any tool calls against our own code,
3. feed results back and loop (up to `MAX_TOOL_ROUNDS`),
4. stream only the final prose to Agora as OpenAI-shaped SSE chunks.

That indirection is what makes requirement 6 (external action) and
requirement 8 (human escalation) possible at all.

The trade-off: a tool round adds latency before the agent speaks. `filler_words`
covers it with "Let me check that" after 1500ms.

## Request flow for one call

1. Browser picks a random channel and uid.
2. `GET /api/agora/token` mints an RTC token for that pair.
3. Browser joins the channel and publishes its mic.
4. `POST /api/agent/start` mints a *second* token for uid `1001` and calls
   Agora's `/join`, handing over the whole ASR/LLM/TTS config.
5. Agent joins, greets, and the conversation runs.
6. Every user turn: Agora → `/api/llm` → tools → back to Agora → TTS.
7. Browser polls `/api/cases` every 1.5s to render actions as they land.
8. `POST /api/agent/stop` on hang-up, and on unmount as a safety net.

## Files

| Path | Role |
| --- | --- |
| `lib/agent-config.ts` | System prompt, greeting, agent name |
| `lib/agora-rest.ts` | Conversational AI REST wrapper + full pipeline config |
| `lib/tools.ts` | Tool schemas and their implementations |
| `lib/store.ts` | In-memory cases and escalations |
| `lib/use-voice-agent.ts` | Client: RTC join, mic, transcript, lifecycle |
| `app/api/llm/route.ts` | OpenAI-compatible proxy with the tool loop |
| `app/api/agent/*` | Agent start/stop |
| `app/api/agora/token` | RTC token minting |
| `app/api/cases` | Read model for the actions panel |

## Known limitations

- `lib/store.ts` is in-memory. A server restart wipes it; it does not survive
  multiple instances. Fine for a demo, not for anything else.
- One user per agent — Agora currently supports a single `remote_rtc_uids`
  entry.
- `MAX_TOOL_ROUNDS` is 5. Deeper chains get cut off silently.
- The transcript parser is tolerant by design and drops frames it cannot read.
- Tokens last one hour; a call longer than that will drop.

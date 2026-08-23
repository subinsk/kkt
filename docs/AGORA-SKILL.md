# Agora Skill + MCP

Installed from https://github.com/AgoraIO/skills (MIT, v1.8.1).

- Skill: `.claude/skills/agora/` — `SKILL.md` plus 54 reference files
- MCP: `.mcp.json` declares `agora-docs-mcp` at `https://mcp.agora.io`

Both are committed with the repo, so the skill travels with the project rather
than living in a global config you have to re-set-up at the venue.

> **Restart Claude Code** (or your editor) after pulling — skills and project
> MCP servers are loaded at startup.

## What it covers

Routing across RTC · RTM · **ConvoAI** · Agora CLI · Cloud Recording · Server
tokens · Server Gateway, with `references/conversational-ai/` alone holding 18
files: quickstarts, auth flow, architecture, custom LLM, server SDKs (TS /
Python / Go), the client toolkits, UI kit, MCP server, and Studio agents.

Ask in plain language — "add transcripts", "why is my token failing", "start an
agent from Go" — and it loads only the reference it needs.

## MCP tools

| Tool | Input | Returns |
| --- | --- | --- |
| `search-docs` | `{"query": "..."}` | Matching doc URIs |
| `get-doc-content` | `{"uri": "docs://..."}` | Full markdown |
| `list-docs` | `{"category": "...", "limit": 20}` | Docs in a category |

Docs traversal only — it cannot log in, create projects, or write env files.
That is the `agora` CLI's job. The skill also notes MCP is optional and should
be used **only when explicitly asked**; the default is its own local references.

Alternative install if you prefer it global:

```
/plugin marketplace add AgoraIO/skills
/plugin install agora@agora-skills
```

## What it confirmed about this repo

**The LLM proxy is the right architecture.** Agora's own reference
implementation — [AgoraIO-Conversational-AI/server-custom-llm](https://github.com/AgoraIO-Conversational-AI/server-custom-llm)
— is described as an "OpenAI-compatible LLM proxy for Agora Conversational AI.
Intercepts LLM requests for RAG, tool calling, and conversation memory," with
server-side tool execution. That is exactly what `app/api/llm/route.ts` does.

**One correction applied:** their proxy runs up to **5** tool passes; ours was
capped at 4. Now 5.

**Basic auth is fine.** We authenticate to the ConvoAI REST API with
`Basic base64(customerId:customerSecret)`. The skill documents an alternative —
`Authorization: agora token=<convoAI token>`, where that token is a combined
RTC+RTM token from `RtcTokenBuilder.buildTokenWithRtm()`. Both are valid; Basic
needs no token rotation, so we keep it.

## The three tokens, since this is where people lose an hour

| Token | Made by | Used by |
| --- | --- | --- |
| RTC client token | your server | browser joining the channel |
| RTM client token | your server | browser calling `rtmClient.login()` |
| ConvoAI server token | your server (Token Auth mode) | your server → ConvoAI REST |

They all take the same App ID + certificate as input, which is exactly why they
get confused. The ConvoAI server token is **not** the RTC token the client
joins with, even though both come from `RtcTokenBuilder`.

We only need the first one today, because we use the RTC datastream for
transcripts instead of RTM. Adding RTM means minting the second.

## Two upgrades this surfaced, not yet taken

**`agora-agents` (TypeScript server SDK).** In App Credentials mode it
generates the ConvoAI token per request automatically, replacing our hand-rolled
REST calls in `lib/agora-rest.ts`. Less code. We keep REST for now because it
works and it is one fewer dependency to debug at a venue.

**`agora-agent-client-toolkit-react`.** Gives `useTranscript`, `useAgentState`,
`useAgentError`, `useAgentMetrics` via a `ConversationalAIProvider`, replacing
the transcript parsing we hand-rolled in `lib/use-voice-agent.ts` — and
`useAgentState` would drive the 3D voice ring more accurately than an FFT
threshold.

```bash
npm install agora-agent-client-toolkit-react agora-agent-client-toolkit agora-rtc-react agora-rtm
```

Requires RTM, so it means combined tokens and `data_channel: "rtm"`. Worth it
if the client is fighting you; not worth starting the day with.

## One thing to be honest about

The skill sets a **hard gate**: do not generate ConvoAI code from memory —
clone the official quickstart, prove it end to end, then adapt. Its exact
wording for projects like ours is *integration mode*: clone the official source
first, then adapt only the needed pieces.

This repo was built from the official REST API reference rather than from the
quickstart. That is not the same as inventing it, but it is not the gate the
skill asks for either — and the organisers independently asked everyone to have
[agent-quickstart-nextjs](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs)
running before the day.

**So: run the quickstart first.** It proves your credentials, your Agora
project, and your machine, which is the real point. Then keep this repo's
layers on top — the tool loop, the 3D scene, the Vobiz phone leg — and lift
anything from the quickstart that works better than ours (the UIKit visualiser
and `AGENT_METRICS` are the obvious candidates).

If the quickstart disagrees with something here, the quickstart wins.

## Agora CLI

The skill leans on a CLI for onboarding — login, project binding, env writing,
`project doctor`.

```bash
curl -fsSL https://raw.githubusercontent.com/AgoraIO/cli/main/install.sh | sh
```

Then `agora init`, `agora quickstart env write`, `agora project doctor`. The
skill wants version `0.1.7` or above. This is the fastest route from "I have an
account" to "my `.env.local` is correct", which is worth more than it sounds at
9am with venue wifi. Untested here — no Agora account in this environment.

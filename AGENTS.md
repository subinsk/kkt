<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# Project rules — Kaun Katega Taarpati (KKT)

Spec: [kaun-katega-taarpati-spec.md](kaun-katega-taarpati-spec.md). It is the
source of truth for game design. This file is the source of truth for how to work.

## Never write Agora or Vobiz code from memory

Both APIs are moving targets and wrong field names fail *silently* here — a bad
`answer_url` is dead air, not an error; a missing RTM flag means transcripts
just never arrive. So, before touching any Agora or Vobiz surface:

**Agora** — follow `.claude/skills/agora/` (invoke the `agora` skill). Level 1 is
the bundled `references/`. When those don't cover it, Level 2 is
`references/doc-fetching.md`: the `agora-docs-mcp` server first, then
`https://docs-md.agora.io/en/<path>.md` directly. Never free-form web search for
Agora, and never invent a parameter.

**Vobiz** — [docs/VOBIZ.md](docs/VOBIZ.md) holds what has been verified so far.
For anything not in it, fetch the docs: append `.md` to any page under
`https://vobiz.ai/docs/`, or read `https://vobiz.ai/docs/llms-full.txt`. There is
also an MCP server at `https://vobiz.ai/docs/mcp`.

When a lookup resolves something the docs left ambiguous, **write it back into
`docs/VOBIZ.md` or `docs/AGORA-NOTES.md` with the date** so the next session does
not re-derive it.

If a doc cannot be fetched, say so plainly and mark the value UNVERIFIED in code.
Do not guess and do not present a guess as documented.

## Verified so far (23 Aug 2026)

- Vobiz `<Play loop="0">` loops **indefinitely** until hangup. `loop` is the only
  `Play` attribute. An unreachable audio file is **skipped silently**.
- Agora Sarvam TTS: `vendor: "sarvam"`, params `api_subscription_key`, `speaker`
  (`anushka|manisha|vidya|arya|abhilash|karun|hitesh`), `target_language_code`,
  `pitch` [-0.75,0.75], `pace` [0.3,3.0], `loudness` [0.1,3.0], `sample_rate`.
- Agora Sarvam ASR: `vendor: "sarvam"`, params `api_key` + `language`.
  `language: "unknown"` enables auto-detection — that is the Hinglish lever.
- `remote_rtc_uids: ["*"]` (array, wildcard) covers all three players including
  late joiners. `agent_rtc_uid` is a **string**.
- Transcript items are `{ uid, turn_id, text, status, metadata }` — they *do*
  carry a uid. **UNVERIFIED at runtime:** whether that uid resolves to the
  individual player in a 3-publisher channel, or only separates agent from user.
  Resolve by experiment in hour one; level-telemetry attribution is the fallback.
- RTM transcripts need **both** `advanced_features.enable_rtm: true` and
  `parameters.data_channel: "rtm"`. One without the other fails silently.
- `POST /agents/{id}/speak` with `interruptable: false` exists — use it for
  deterministic host lines instead of round-tripping the LLM.
- `POST /agents/{id}/interrupt` cuts the agent off mid-utterance.
- **Agora does NOT host an LLM.** You must supply your own endpoint and key. The
  supported providers are OpenAI, Azure OpenAI, Groq, Gemini, Vertex, Anthropic,
  Bedrock, Dify, xAI, and any custom OpenAI-compatible API. There is no
  Agora-billed model to fall back on.
- Agora's *Studio* path (`pipeline_id` instead of `llm`/`tts`/`asr` blocks) is
  **wrong for this project** — it replaces the `llm` block, and our whole
  architecture depends on `llm.url` pointing at our own proxy so we can inject
  authoritative game state each turn.
- **Groq:** every Groq model supports tool calling, in the OpenAI-compatible
  `tool_calls` format. Base URL `https://api.groq.com/openai/v1`. Parallel tool
  calls work on `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`,
  `qwen/qwen3.6-27b`, `minimaxai/minimax-m2.7` — but **not** on
  `openai/gpt-oss-20b` / `gpt-oss-120b`, so avoid those two here.
- Sarvam TTS `abhilash`/`karun`/`hitesh` are the male voices; `anushka`,
  `manisha`, `vidya`, `arya` are female.

## Non-negotiables

- **The server owns the clock and the wire state.** The LLM is told the state
  every turn and may never compute it. It will hallucinate the countdown.
- **Answer checking is semantic, never string matching.**
- Restarting `cloudflared` changes the tunnel URL, which silently breaks
  `PUBLIC_BASE_URL` and every webhook. `npm run dev` renews and verifies the
  tunnel as part of starting the server; `npm run tunnel` does it alone. Never
  paste a hostname into `.env.local` by hand — the verification is the point.
  See the `tunnel` skill.
- **Run `npm run check` before every rehearsal**, and open `/api/health`. Both
  exist to make the *silent* failures loud: a stale tunnel URL, a missing hint
  MP3 (Vobiz skips unreachable audio without erroring, so it becomes dead air on
  a live call), a missing outcome stinger.
- There is **no ticking timer** anywhere. The clock is derived from timestamps in
  `secondsLeft()`. Do not add a `setInterval` that decrements a counter — it
  drifts, dies on hot reload, and double-counts if two ever race.

## Before you change one line

A one-line change here routinely breaks something three files away without
erroring. `.claude/skills/blast-radius/` lists the seams that fail *silently* —
the `publicView()` wire format, the LLM tool contract, the SSE resume contract,
audio filenames, Vobiz callback URLs, the Agora agent payload, env vars, and the
game rules. Invoke the `blast-radius` skill before editing any of them.

## Tooling

Candidate Claude Code skills and hooks for this repo — including which of the
non-negotiables above could be enforced by a hook instead of by memory — are
triaged in [docs/CLAUDE-TOOLING.md](docs/CLAUDE-TOOLING.md), along with what is
already installed.

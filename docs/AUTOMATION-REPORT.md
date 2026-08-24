# Claude Code automation recommendations

Produced 24 Aug 2026 by the `claude-automation-recommender` skill from the
`claude-code-setup` plugin. That skill is read-only — it reports, it does not
write. Nothing below is implemented yet.

## Codebase profile

| | |
|---|---|
| **Type** | TypeScript, Node 22, 136 tracked files |
| **Framework** | Next.js 16.3.2 App Router, React 19.2.8 |
| **Key libraries** | `agora-rtc-sdk-ng` 4.24.7, `agora-token`, `three` 0.185 + `@react-three/fiber` 9 + `drei` 10, Tailwind v4, `qrcode` |
| **Backend** | 16 route handlers under `app/api/`, in-memory store, SSE |
| **Tests** | No framework. One scripted round: `scripts/engine-check.ts` |
| **Lint / format** | **None configured** — no ESLint, no Prettier, no editorconfig |
| **CI** | **None** — no `.github/workflows` |
| **Deploy** | Render blueprint ([render.yaml](../render.yaml)) |
| **Existing Claude config** | `AGENTS.md`, `.mcp.json` (agora-docs-mcp), `.claude/skills/{agora,blast-radius}`, `.claude/settings.json`, no `.claude/agents/` |

The two signals that matter most: **there is no lint or format tooling**, so the
usual auto-format hooks do not apply — but `tsconfig.json` and a working
`npm run check` both exist, so type and rules enforcement does. And **there is no
CI**, which means every guard has to live in a hook or in `npm run check`.

## MCP servers

### 1. Vobiz docs MCP — the real gap

AGENTS.md forbids writing Vobiz code from memory, and Agora has two safety nets
for that (the `agora` skill plus `agora-docs-mcp` in `.mcp.json`). **Vobiz has
neither.** A server is documented at `https://vobiz.ai/docs/mcp`.

```jsonc
// .mcp.json — alongside the existing agora-docs-mcp entry
"vobiz-docs": { "type": "http", "url": "https://vobiz.ai/docs/mcp" }
```

One line, checked into the repo, and it closes the asymmetry between the two
vendor APIs that fail silently.

### 2. serena — blocked on a missing prerequisite

Installed but cannot start: it launches through `uvx`, and neither `uv` nor
`uvx` is on this machine. Either `winget install --id=astral-sh.uv` or accept
that the server is inert. `context7` (installed, anonymous, no prerequisites)
already covers the library-docs half.

## Hooks

`.claude/settings.json` currently holds only `enabledPlugins`. Ranked by value
here, and note **none of the standard format-on-save hooks apply** — there is no
formatter to run.

### 1. Stale tunnel guard — `SessionStart`

The highest-value hook in this repo, because it is the failure AGENTS.md singles
out: restarting `cloudflared` changes the URL, `PUBLIC_BASE_URL` goes stale, and
every webhook breaks *without erroring*. A session-start check that compares
`.env.local`'s value against the live tunnel turns an invisible failure into a
line of text before any work starts.

### 2. Type-check on edit — `PostToolUse` on `Edit`/`Write`, `*.ts`/`*.tsx`

`tsc --noEmit` is already half of `npm run check`. Running it per-edit catches a
broken `lib/game/state.ts` at the edit rather than at the next rehearsal. Report
only — no blocking.

### 3. `setInterval` tripwire — `PostToolUse`

AGENTS.md: there is no ticking timer anywhere; the clock derives from
`secondsLeft()`. A grep over `lib/game/` and `components/` after each edit guards
the one invariant that review cannot see and that only shows up as clock drift on
stage.

### 4. `npm run check` before commit — `PreToolUse` on `Bash` matching `git commit`

Removes the "I forgot to run it" path. This is the one hook that would *block*,
so it is the one to opt into deliberately rather than by default.

### Considered and rejected

**Blocking edits to `.env.local`** — the standard recommendation for a repo with
env files, and wrong here. Updating `PUBLIC_BASE_URL` in `.env.local` after a
tunnel restart is a routine, documented step; a block would break the normal
workflow to protect against a problem this repo does not have.

**Auto-format / auto-lint on edit** — nothing to run. Worth noting the absence
is itself a choice: adding ESLint + Prettier now would make these hooks
available, at the cost of a formatting pass over 136 files.

## Subagents

`.claude/agents/` does not exist. One is worth adding:

**`silent-failure-reviewer`** — reviews a diff against exactly the seams in
`.claude/skills/blast-radius/`: did a `publicView()` field get renamed without
its consumers, did a tool name drift between `tools.ts` and `llm.ts`, did an
audio filename or a Vobiz callback route move, did a new env var reach
`render.yaml`. The skill tells *me* to check before editing; the subagent checks
*after*, on the diff, in parallel. Different job, same knowledge.

## Skills

Two worth creating, both already reasoned about in
[CLAUDE-TOOLING.md](CLAUDE-TOOLING.md):

**`vobiz`** (Claude-invocable) — generated from `https://vobiz.ai/docs/llms-full.txt`,
mirroring `.claude/skills/agora/`. Cheaper alternative: just add the MCP server
above.

**`rehearsal`** (user-only, `disable-model-invocation: true`) — wraps the
pre-demo checklist that currently lives in prose in
[DEPLOY.md](DEPLOY.md#pre-demo-checklist): `npm run check`, `/api/health` clip
counts, confirm the tunnel, confirm base-URL source and serving host match. It
has side effects and a fixed order, which is exactly the shape the recommender
flags as user-invoked rather than model-invoked.

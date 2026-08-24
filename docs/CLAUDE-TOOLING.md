# Claude Code tooling for this repo

## Installed

Restart Claude Code (or `/reload-plugins`) after any change here.

| Plugin | Scope | What it adds | Index cost |
| --- | --- | --- | --- |
| `superpowers` | user | 14 skills + a `SessionStart` hook | ~465 tok |
| `playwright` | project | Playwright MCP server | 0 (no skills) |
| `typescript-lsp` | project | TS/JS language server | 0 |
| `context7` | project | Version-specific library docs over MCP | 0 |
| `frontend-design` | project | 1 skill: production-grade UI | ~51 tok |

Plus two repo-local skills: `.claude/skills/agora/` and
`.claude/skills/blast-radius/`. Project scope lives in `.claude/settings.json`,
which is untracked — commit it to share, or leave it local to this machine.

"Index cost" is the `name` + `description` text that sits in context **every
turn**, whether or not the skill is ever used. It is the number that decides
whether a plugin earns its place.

## Disabled, and why — the overlap question

Four plugins were installed and then turned off on 24 Aug 2026 after measuring
them. `claude plugin uninstall` currently refuses them with a stale "enabled at
project scope" error even when `list` and `disable` both report them disabled;
disabled is functionally equivalent — their skills leave the index — and
uninstall should succeed after a restart.

### The mechanism, from the docs

Overlapping skills do not cause factual hallucination. Three documented effects
are the real cost:

1. **Selection is description-driven.** "The `description` helps Claude decide
   when to load the skill automatically." Two skills whose descriptions fire on
   the same trigger make the choice between them effectively arbitrary.
2. **A loaded body never leaves.** "When you or Claude invoke a skill, the
   rendered `SKILL.md` content enters the conversation as a single message and
   stays there for the rest of the session… Claude Code does not re-read the
   skill file on later turns." So two competing procedures for the same job do
   not take turns — they sit in context together, permanently, and get blended.
3. **Compaction evicts skills.** Re-attached skills share a 25,000-token budget
   filled most-recent-first, "so older skills can be dropped entirely after
   compaction if you have invoked many in one session." The two that must never
   be evicted here are `agora` and `blast-radius`.

Amplifier: superpowers' `SessionStart` hook injects `using-superpowers`, which
says that if there is "even a 1% chance a skill might apply… you ABSOLUTELY MUST
invoke the skill." That directive multiplied by a large index is what turns index
size into loaded-body size.

### What was measured

| Plugin | Skills | Index cost | Verdict |
| --- | --- | --- | --- |
| `render` | 21 | **~2,078 tok** | Disabled |
| `mattpocock-skills` | 35 | ~1,321 tok | Disabled |
| `serena` | 0 (MCP only) | 0 | Disabled — never started |
| `claude-code-setup` | 1 | ~88 tok | Disabled — job done |

**`render`** was the single largest cost in the whole set, and 19 of its 21
skills are for infrastructure this project does not have: Postgres, Docker,
disks, cron jobs, key-value, autoscaling, static sites, private services, private
networking, background workers, Heroku migration. KKT is one free web service
with a settled [render.yaml](../render.yaml). Re-enable it for the minute that
file next needs work.

**`mattpocock-skills`** collides with superpowers head-on, and the bodies are
large enough that a blended procedure is a real outcome rather than a theoretical
one:

| Job | superpowers | mattpocock |
| --- | --- | --- |
| Debugging | `systematic-debugging` (1,430 w) | `diagnosing-bugs` (1,402 w) |
| TDD | `test-driven-development` (1,367 w) | `tdd` (555 w) |
| Code review | `requesting-code-review` (419 w) | `code-review` (1,049 w) |
| Planning | `writing-plans` (1,048 w) | `to-spec` (493 w) |
| Skill authoring | `writing-skills` (3,730 w) | `writing-for-agents` (1,775 w) |

It also ships a second router (`ask-matt`) competing with `using-superpowers`,
and six skills still marked **in-progress** (`claude-handoff`, `loop-me`,
`setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`)
that sit in the index regardless. Both libraries are good; the point is to run
one methodology rather than an average of two. Superpowers stays because it is
the one that was asked for and the one wired to a hook.

**`serena`** never started: its server launches through `uvx`, and neither `uv`
nor `uvx` is on this machine, so it was inert rather than merely redundant. It
also overlaps `typescript-lsp`, which does the find-references job that
`blast-radius` actually needs. Revisit only if that proves thin — install uv
first (`winget install --id=astral-sh.uv`).

**`claude-code-setup`** is a read-only advisor and its report is written down in
[AUTOMATION-REPORT.md](AUTOMATION-REPORT.md). Nothing left for it to do.

Net effect: plugin skill index down from ~4,005 to ~516 tokens, with no
capability lost that this project uses.

### superpowers (obra / Jesse Vincent, MIT)

Skills: `brainstorming`, `writing-plans`, `executing-plans`,
`systematic-debugging`, `test-driven-development`, `verification-before-completion`,
`requesting-code-review`, `receiving-code-review`, `subagent-driven-development`,
`dispatching-parallel-agents`, `using-git-worktrees`,
`finishing-a-development-branch`, `writing-skills`, `using-superpowers`.

Its `SessionStart` hook (on `startup|clear|compact`) injects the
`using-superpowers` text so the index is always live. Plain bash with a `.cmd`
shim, so it works on this Windows box. `claude plugin disable superpowers` turns
it off without uninstalling — worth knowing, because that hook is the most
opinionated thing in the installed set.

Most relevant here: `systematic-debugging`, `verification-before-completion` (a
natural fit for a repo whose non-negotiables are all "run the check, don't
assume"), and `brainstorming`.

### playwright

MCP server, `npx @playwright/mcp@latest`. Downloads on first use and wants
browser binaries, so the first invocation is slow and needs network. Nothing is
wired to it yet — see the gap it exists to close, below.

### typescript-lsp

Language server for `.ts`/`.tsx`. Cheap, no skills, and it supplies the
mechanical half of `blast-radius` — real find-references instead of grep.

### context7

Hosted MCP (`https://mcp.context7.com/mcp`) serving version-specific docs from
source repos. Anonymous; `CONTEXT7_API_KEY` only raises rate limits. AGENTS.md
opens with "This is NOT the Next.js you know," and the same applies to `three`
and `@react-three/fiber` across `components/stage/`. It does **not** replace the
Agora and Vobiz rules — those still go through the `agora` skill,
`agora-docs-mcp`, and the Vobiz docs.

### frontend-design

One skill, ~51 tokens of index, for UI that does not look machine-generated.
Relevant while the landing page and `components/stage/` are in flux. Overlaps the
built-in `design` and `artifact-design` skills, but at this size the overlap is
not worth acting on.

### blast-radius (repo-local)

Written for this repo, not installed from anywhere. It answers "I am changing one
line — what else does that touch?" by naming the eight seams here that fail
*without erroring*: the `publicView()` wire format, the LLM tool contract across
`tools.ts`/`llm.ts`, the SSE `?since=` resume contract, audio filenames across
their three producers, Vobiz callback URLs, the Agora agent payload, the five
files a new env var touches, and the game rules versus `check:engine`.

No marketplace plugin does this. `serena` and `greptile` do dependency *search*,
which is the mechanical part, but none of them know that Vobiz skips unreachable
audio silently. That knowledge is the whole value, and it only exists here.

---

## Still worth doing

### 1. A Vobiz skill, generated from the docs

[AGENTS.md](../AGENTS.md) opens with "never write Agora or Vobiz code from
memory." Agora has a bundled skill at [.claude/skills/agora/](../.claude/skills/agora/)
and an MCP server in [.mcp.json](../.mcp.json). **Vobiz has neither** — only
[docs/VOBIZ.md](VOBIZ.md), a hand-kept log of what we happened to verify, plus a
reminder that `https://vobiz.ai/docs/llms-full.txt` and an MCP server at
`https://vobiz.ai/docs/mcp` exist.

Two ways to close it, cheapest first:

- Add the Vobiz docs MCP server to `.mcp.json` alongside `agora-docs-mcp`. One
  config line, no generation step, and zero skill-index cost.
- Generate `.claude/skills/vobiz/` from `llms-full.txt`, structured like the
  agora skill — a routing `SKILL.md` plus `references/` for XML verbs, webhooks,
  and call control. Superpowers' `writing-skills` skill can do this; a
  third-party generator is not needed.

Either way, `docs/VOBIZ.md` stays as the dated runtime-verified log. The skill is
what the docs *say*; `VOBIZ.md` is what we *observed*, and the second one wins
when they disagree.

### 2. Hooks for the non-negotiables

Every rule in the "Non-negotiables" section of AGENTS.md is currently enforced by
hoping the agent remembers it. Hooks turn each into a shell exit code. Use the
`update-config` skill to install these into `.claude/settings.json` rather than
hand-writing JSON. Native hooks are enough — no hook framework needed in a repo
whose dev chain is `tsc` + `tsx`.

- **Stale tunnel guard.** `SessionStart` or `UserPromptSubmit`: compare
  `PUBLIC_BASE_URL` in `.env.local` against the live `cloudflared` tunnel, warn
  on divergence. AGENTS.md calls this out as silently breaking every webhook, and
  one `curl` detects it.
- **`npm run check` before commit.** `PreToolUse` on `Bash` matching
  `git commit`: run it, exit non-zero on failure. The script already checks for
  missing hint MP3s and stingers; the hook removes the "I forgot" path. This is
  the only one that *blocks*, so opt into it deliberately.
- **Typecheck on edit.** `PostToolUse` on `Edit`/`Write` for `*.ts`/`*.tsx`:
  `tsc --noEmit`. Catches a broken `lib/game/state.ts` at edit time instead of at
  rehearsal.
- **`setInterval` tripwire.** `PostToolUse` grep over `lib/game/` and
  `components/`, warning with a pointer to the `secondsLeft()` rule. Narrow and
  cheap, and it guards the one invariant that is invisible in review and only
  shows up as clock drift on stage.
- **Notifications.** `Notification` + `Stop` hooks that beep or toast. Useful
  when `next build`, `render:hints`, or a rehearsal is running and attention is
  on the phone rather than the terminal.

Rejected, though it is the textbook recommendation for a repo with env files:
**blocking edits to `.env.local`**. Updating `PUBLIC_BASE_URL` there after a
tunnel restart is a routine documented step, so a block would break the normal
workflow to prevent a problem this repo does not have.

### 3. An actual browser test of the join flow

The Playwright MCP server is installed; nothing uses it yet.

[scripts/engine-check.ts](../scripts/engine-check.ts) asserts the rules engine —
clock, wire double-cut, lifeline refunds, phone-number scrubbing — but nothing
covers the browser half: host creates room → QR resolves → three phones join →
stage renders → scoreboard updates. That path has already broken twice in recent
history ("QR falls back to the page origin instead of vanishing", "Only the host
creates rooms"). A scripted three-context run is the natural sibling to
`check:engine` and the only way to catch those before a rehearsal.

### 4. Point superpowers' debugging skill at our failure mode

`systematic-debugging` is generic root-cause discipline, which is fine but not
aimed at what actually goes wrong here: **silent** failures. An unreachable
Vobiz audio file becomes dead air. A missing RTM flag means transcripts never
arrive. A bad `answer_url` returns no error at all.

Worth more than the generic skill alone: a short `.claude/skills/debug-silence/`
encoding the checklist we keep re-deriving — hit `/api/health` first, confirm the
tunnel, confirm the MP3 is reachable *from outside*, confirm both RTM flags, then
look at code. Source it from [docs/AI-LIMITATIONS.md](AI-LIMITATIONS.md) and the
verified-so-far list in AGENTS.md.

### 5. A `silent-failure-reviewer` subagent

`.claude/agents/` does not exist yet. The counterpart to `blast-radius`: the
skill tells *me* to check the seams before editing, a subagent checks the *diff*
afterwards, in parallel. Same knowledge, different moment.

---

## Researched, worth knowing, not installed

All from the official marketplace (286 plugins as of 24 Aug 2026).

- **`claude-md-management`** (Anthropic) — audits CLAUDE.md quality and captures
  session learnings. Fits the standing rule that a resolved ambiguity gets
  written back into `docs/VOBIZ.md` or `docs/AGORA-NOTES.md` with the date.
- **`langfuse-observability`** — LLM tracing. Would make `/api/llm` prompt and
  tool-call behaviour inspectable after the fact instead of guessed at from the
  host's speech. Real value, but it means adding a service.
- **`greptile`**, **`superdesign`** — need third-party accounts.
- **`chrome-devtools-mcp`** — the built-in `web-perf` skill already drives it.
- **`pr-review-toolkit`**, **`modern-web-guidance`** — overlap the built-in
  `code-review` skill and AGENTS.md respectively.
- **`vercel`** — the deploy is gone; see below.

`code-review@claude-plugins-official` and `skill-creator@claude-plugins-official`
were already installed at project scope and disabled before any of this. Left as
found.

### On the Vercel deploy

Removed on 24 Aug 2026: `vercel.json` deleted, and the live link dropped from
[README.md](../README.md) and [docs/DEPLOY.md](DEPLOY.md). It could never host a
playable round — the room is in-memory and the SSE stream stays open for the
whole six minutes — so a second URL that looked playable was a liability. The
*rationale* stays in DEPLOY.md, and the `VERCEL_PROJECT_PRODUCTION_URL` fallback
stays in [lib/env.ts](../lib/env.ts) so the app remains portable.

### From the community round-up that started this file

Tapestry and knowledge-graph tooling (`docs/` is twelve readable files), invoice
and file organizers, EPUB and PDF analyzers, YouTube extractors, `ffuf` fuzzing,
pypict combinatorial test generation, Discord/Slack session streaming, and the
PHP hook SDK. Nothing in the game touches those problems. The community hook
frameworks (johnlindquist/claude-hooks, GowayLee/CCHooks) are typed wrappers
around the same native events listed in section 2 — the wrapper is the part we do
not need.

The round-up's own closing lesson turned out to be the operative one here:
skills that solve **one** specific problem work, and installing too much at once
does not.

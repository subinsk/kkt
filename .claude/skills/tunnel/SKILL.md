---
name: tunnel
description: >-
  Renew the cloudflared quick tunnel and repoint PUBLIC_BASE_URL at it. Activate
  whenever localhost is (re)started, the tunnel is restarted or dies, before any
  rehearsal or live run, or when the symptom is a silent one — the host says
  nothing, a lifeline call rings then goes quiet, hint audio never plays, Agora
  tool calls never arrive. Also when asked to "renew the tunnel", "update the
  URL", or "fix PUBLIC_BASE_URL".
---

# Tunnel

`npm run dev` already does this. The skill exists for the times it did not run,
or ran and something downstream still looks wrong.

## Do this

```bash
npm run tunnel
```

That is the whole procedure. It kills any live cloudflared, starts a new quick
tunnel against `:3000`, rewrites `PUBLIC_BASE_URL` in `.env.local`, waits for
`/api/health` *through the new hostname*, and fetches every hint and stinger over
the tunnel. It exits non-zero if any of that fails. Read the summary it prints —
do not re-derive it by hand.

Flags: `--port N` for a dev server elsewhere, `--keep-alive` to leave an
already-healthy tunnel alone, `--wait N` to wait N seconds for a server that is
still booting.

## Why this is not a one-liner

Every failure in this area is silent. A stale hostname does not throw:

- Agora is handed a dead `llm.url`, so tool calls never arrive and the host has
  no game state to talk about.
- Vobiz is handed a dead `answer_url`. The phone rings, the callee answers, and
  there is nothing on the line.
- **Vobiz skips audio it cannot fetch, without erroring.** A hint MP3 behind a
  dead hostname is not an error in any log. It is dead air on a live call.

`/api/health` reporting `present: true` for audio does not cover this — that is a
local-filesystem check. The question that matters is whether the public internet
can fetch those files right now, which is why the script asks it directly.

## Where the URL lives

`.env.local` only, one line. Everything else derives it per request:
[lib/env.ts](../../../lib/env.ts), the Vobiz `answer_url` built per call in
[lib/game/lifeline.ts](../../../lib/game/lifeline.ts), and
[app/api/join-url/route.ts](../../../app/api/join-url/route.ts). There is no
second copy to keep in sync — if you find yourself editing a hostname anywhere
else, that is the bug.

## When it fails

**"No response from …/api/health"** — Cloudflare sometimes hands out a
quick-tunnel hostname it never publishes in DNS, usually after several tunnels
in quick succession. Confirm with `nslookup <host>`; if it is NXDOMAIN, run
`npm run tunnel` again and take the next hostname. Nothing is wrong with the code.

**"health still reports publicBaseUrl=<old>"** — the dev server did not pick up
`.env.local`. Restart it.

**"cloudflared printed no hostname"** — read the log path in the error. If it is
empty, cloudflared started but its output went nowhere; see the comments in
[scripts/tunnel.mjs](../../../scripts/tunnel.mjs), which record the two spawn
settings on Windows that cause exactly that.

## Do not

- Do not hand-edit `PUBLIC_BASE_URL` after starting a tunnel manually. The
  verification is the point, not the assignment.
- Do not leave a cloudflared running after the dev server stops. It resolves,
  502s on every request, and enough orphans in a row is what makes Cloudflare
  stop publishing DNS for new ones.
- Do not trust a tunnel from a previous session before a rehearsal. Re-run it.

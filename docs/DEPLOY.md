# Deploying

## Live deployments

| | URL | |
|---|---|---|
| **Render** | <https://kaun-katega-taarpati.onrender.com> | The one to demo. One long-lived Node process, so rooms and the SSE stream actually work. Free tier — spins down after ~15 min idle, so hit it once before showing anyone. |
| **Vercel** | <https://kkt-omega.vercel.app/> | Serverless. The UI loads and the set renders, but for the reasons below a room does not survive between requests. Treat it as a shop window, not a playable build. |

**These two do not talk to each other.** They are independent copies of the same
app, each with its own memory and its own env. Nothing in the code points one at
the other, and there is no state shared between them — a room started on Render
does not exist on Vercel.

The URL each one needs is *its own*, because the inbound traffic comes from
elsewhere: Agora's cloud fetches `/api/llm` and Vobiz's cloud fetches the
`answer_url` and the hint `.wav`. That is what `PUBLIC_BASE_URL` is for, and
[`lib/env.ts`](../lib/env.ts) now derives it from the host, so there is nothing
to paste in. See [Wiring the public URL](#wiring-the-public-url).

## The one thing to know first

**This app cannot run a *game* on Vercel, Netlify, or Cloudflare Workers.**
Not a preference — it is architecturally incompatible with serverless. The
Vercel deploy above builds and serves pages; it is the stateful half that
breaks:

| What | Why serverless breaks it |
|---|---|
| `lib/game/store.ts` holds rooms in memory | Every invocation is a fresh process. The room would vanish between two requests from the same phone. |
| `/api/room/[code]/events` is SSE | The stream stays open for the whole six-minute round. Serverless caps and bills by duration. |
| The running agent id is a module-level `Map` | Lost on every cold start, so `/interrupt` and `/speak` would stop finding the agent. |

It needs **one long-lived Node process**. Everything below gives you that.

Making it serverless-compatible means moving state to Redis and events to a
hosted pub/sub. That is a real afternoon of work and buys nothing for a
six-minute demo — do not start it today.

---

## For the event itself: run it locally

This is the recommendation, not a fallback.

```bash
npm run dev
npx cloudflared tunnel --url http://localhost:3000
# put the printed https URL into PUBLIC_BASE_URL, then restart npm run dev
```

Why this beats deploying, on the day:

- **Lowest possible latency** to the phones in the room, because the server *is*
  in the room. Deployed, every turn round-trips to a datacentre and back.
- **No cold start.** A free-tier host that has been idle takes 30–60 seconds to
  wake, and it will be idle at exactly the wrong moment.
- **You can read the logs** while it happens.
- Nothing to redeploy when you change a prompt between rehearsals.

The one catch: **restarting `cloudflared` changes the URL**, which silently
breaks the LLM proxy and every Vobiz webhook. Nothing errors — the host just
never speaks. Re-check `/api/health` after any tunnel restart; it now detects
both localhost and the placeholder.

---

## Free-tier hosting: Render

For judges to try it later, or as a backup. Free, and it gives you a real
process.

**1.** Push to GitHub (`.env.local` is gitignored — keep it that way).

**2.** <https://render.com> → New → **Blueprint** → pick the repo. It reads
[`render.yaml`](../render.yaml), which is already written: Node 22, region
Singapore (closest to India, and RTC signalling latency is real), health check on
`/api/health`.

**3.** Set the secrets it prompts for — everything marked `sync: false`:

```
NEXT_PUBLIC_AGORA_APP_ID      AGORA_APP_CERTIFICATE
AGORA_CUSTOMER_ID             AGORA_CUSTOMER_SECRET
SARVAM_API_KEY                LLM_API_KEY
VOBIZ_AUTH_ID                 VOBIZ_AUTH_TOKEN
VOBIZ_FROM_NUMBER             FALLBACK_FRIEND_NUMBER
```

**4.** Deploy. **`PUBLIC_BASE_URL` needs no second pass** — Render sets
`RENDER_EXTERNAL_URL` to the service's own https URL and the app falls back to
it. Set `PUBLIC_BASE_URL` in the dashboard only to override, e.g. a custom
domain.

**5.** Open `/api/health`. Green means go — and check `publicBaseSource` reads
`RENDER_EXTERNAL_URL`.

### Free tier limits, honestly

- **Spins down after ~15 min idle**, 30–60s to wake. Hit the URL before demoing.
- **512 MB RAM.** Fine — the whole state is a few objects.
- **Shared CPU.** The LLM proxy is I/O-bound, so this matters less than it sounds.
- **One instance**, which is exactly what in-memory state needs. Do not scale it
  to 2 — two instances means two different games behind one URL.

### Alternatives, same shape

- **Fly.io** — `fly launch` autodetects Next.js. Better free allowance than
  Render and you can pick `bom` (Mumbai), which is the lowest-latency option
  available. Worth it if you have 20 minutes.
- **Railway** — easiest UI, but trial credit rather than a free tier.

Do not use Cloudflare Workers or Pages Functions. Same serverless problem, plus
no Node runtime for `agora-token`.

---

## Wiring the public URL

The only piece of config that is about *where this app lives*, and the one that
has historically been set wrong. It is not a URL for one deployment to reach
another — it is how the two external clouds reach whichever copy is serving.

Three things are built from it, in [`lib/env.ts`](../lib/env.ts):

| Built from it | Fetched by | If wrong |
|---|---|---|
| `llm.url` → `/api/llm` ([`lib/agora-rest.ts`](../lib/agora-rest.ts)) | Agora, every turn | The host never speaks. No error. |
| `answer_url`, `ring_url`, `hangup_url` ([`lib/game/lifeline.ts`](../lib/game/lifeline.ts)) | Vobiz, on call events | The phone rings into silence. |
| `/audio/hints/<wire>_h1.wav` | Vobiz `<Play>` | 45 seconds of dead air — Vobiz skips audio it cannot fetch, without erroring. |

`resolvePublicBase()` picks the first of these that is set:

| Order | Variable | Where it comes from |
|---|---|---|
| 1 | `PUBLIC_BASE_URL` | You. The only option locally, and the override anywhere. |
| 2 | `RENDER_EXTERNAL_URL` | Render, automatically. Full URL, scheme included. |
| 3 | `VERCEL_PROJECT_PRODUCTION_URL` | Vercel, automatically. Hostname only, so `https://` is prepended. |

So, concretely, what to set where:

| Where you are running | What to add |
|---|---|
| Local (`npm run dev`) | `PUBLIC_BASE_URL` in `.env.local` — your cloudflared URL. Required; nothing can derive a tunnel. |
| Render | **Nothing.** Derived. Add `PUBLIC_BASE_URL` only for a custom domain. |
| Vercel | **Nothing**, provided *Settings → Environment Variables → Enable access to System Environment Variables* is ticked. Otherwise add `PUBLIC_BASE_URL=https://kkt-omega.vercel.app`. |

Two notes on the Vercel side. `VERCEL_PROJECT_PRODUCTION_URL` is used rather than
`VERCEL_URL` deliberately: `VERCEL_URL` is per-deployment and changes on every
push, so a preview deploy would hand Agora a URL that is already stale. And if
Deployment Protection is on, the Vercel deploy cannot work regardless of the URL
— Agora and Vobiz arrive unauthenticated and get the auth wall.

`/api/health` reports `publicBaseSource`, so you can see which of the three won
without guessing.

---

## Pre-demo checklist

```bash
npm run check          # typecheck + 49 engine rules
npm run render:audio   # hint clips + outcome stingers
```

then `/api/health` and confirm:

- [ ] `ready: true`, no blocking items
- [ ] `publicBaseUrl` in `/api/health` is the origin actually in use *right now*,
      and `publicBaseSource` is the variable you expect
- [ ] 5/5 hint clips, 2/2 stingers
- [ ] One hint clip opens in a browser at the public URL
- [ ] One test Vobiz call has rung a real handset today
- [ ] Projector **Start** clicked once — this is what unlocks the outcome audio
      against the browser's autoplay policy

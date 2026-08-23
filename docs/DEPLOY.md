# Deploying

## The one thing to know first

**This app cannot run on Vercel, Netlify, or Cloudflare Workers.** Not a
preference — it is architecturally incompatible with serverless:

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

**4.** Deploy, then **set `PUBLIC_BASE_URL` to the service's own URL** —
`https://kaun-katega-taarpati.onrender.com` — and redeploy.

This trips everyone: `PUBLIC_BASE_URL` is how Agora finds `/api/llm` and how
Vobiz finds the `answer_url`. It cannot be known until the service exists, so it
is always a second pass. Leave it wrong and you get a silent, voiceless game.

**5.** Open `/api/health`. Green means go.

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

## Pre-demo checklist

```bash
npm run check          # typecheck + 49 engine rules
npm run render:audio   # hint clips + outcome stingers
```

then `/api/health` and confirm:

- [ ] `ready: true`, no blocking items
- [ ] `PUBLIC_BASE_URL` is the URL actually in use *right now*
- [ ] 5/5 hint clips, 2/2 stingers
- [ ] One hint clip opens in a browser at the public URL
- [ ] One test Vobiz call has rung a real handset today
- [ ] Projector **Start** clicked once — this is what unlocks the outcome audio
      against the browser's autoplay policy

# Deploying

## Live deployment

<https://kaun-katega-taarpati.onrender.com> — Render, one long-lived Node
process, so rooms and the SSE stream actually work. Free tier, so it spins down
after ~15 min idle and takes 30–60s to wake: hit it once before showing anyone.

There is deliberately only one. A serverless copy was tried and removed — the
next section is why it can never host a playable round.

The URL the app needs is *its own*, because the inbound traffic comes from
elsewhere: Agora's cloud fetches `/api/llm` and Vobiz's cloud fetches the
`answer_url` and the hint `.wav`. That is what `PUBLIC_BASE_URL` is for, and
[`lib/env.ts`](../lib/env.ts) derives it from the host, so there is nothing to
paste in. See [Wiring the public URL](#wiring-the-public-url).

## The one thing to know first

**This app cannot run a *game* on Vercel, Netlify, or Cloudflare Workers.**
Not a preference — it is architecturally incompatible with serverless. Such a
deploy builds and serves pages perfectly well; it is the stateful half that
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
```

That starts the dev server *and* renews the tunnel: it rewrites
`PUBLIC_BASE_URL` in `.env.local`, waits for `/api/health` through the new
hostname, and fetches every hint and stinger over the tunnel before telling you
it is ready. `npm run tunnel` does the tunnel half alone, for when the server is
already up. `npm run dev:bare` is `next dev` with no tunnel, for offline UI work.

Why this beats deploying, on the day:

- **Lowest possible latency** to the phones in the room, because the server *is*
  in the room. Deployed, every turn round-trips to a datacentre and back.
- **No cold start.** A free-tier host that has been idle takes 30–60 seconds to
  wake, and it will be idle at exactly the wrong moment.
- **You can read the logs** while it happens.
- Nothing to redeploy when you change a prompt between rehearsals.

The one catch: **restarting `cloudflared` changes the URL**, which silently
breaks the LLM proxy and every Vobiz webhook. Nothing errors — the host just
never speaks. This is why the tunnel is welded to `npm run dev` rather than left
as a step to remember. If you ever start one by hand, run `npm run tunnel`
afterwards rather than pasting the hostname in — the verification is the point.
`/api/health` also detects both localhost and the placeholder.

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

### The audio, on any host

`public/audio/` is gitignored, so the clips are **built, not committed** — every
host has to run `render:audio` itself or ship with silent lifelines:

- Render: already in `buildCommand` in [`render.yaml`](../render.yaml).
- Any other host: put `npm run render:audio` ahead of `npm run build` yourself.
  A plain `npm run build` skips it, and the deploy comes up with 0/5 hints and
  0/2 stingers — silent lifelines, no error.

Either way **`SARVAM_API_KEY` must be set for the environment being built**, not
just at runtime. Without it the build still succeeds — deliberately, since a game
with no lifeline audio beats a game that failed to deploy — so the only signal is
the clip count in `/api/health`. Check it after every deploy.

One wrinkle worth knowing: on a CDN-backed host `public/` is not on the serving
process's filesystem, so an `existsSync` check reports every clip as missing even
when they are served fine. `/api/health` therefore falls back to an
HTTP `HEAD` when the disk says no.

That probe deliberately asks the host that served the request, **not**
`PUBLIC_BASE_URL`. The two can be different origins, and probing
`PUBLIC_BASE_URL` would report some other process's files as proof that this
build shipped them — which is precisely what happened on the first attempt at
this check.

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
| 3 | `VERCEL_PROJECT_PRODUCTION_URL` | Vercel, automatically. Hostname only, so `https://` is prepended. Kept only so the app stays portable — there is no Vercel deploy any more. |

So, concretely, what to set where:

| Where you are running | What to add |
|---|---|
| Local (`npm run dev`) | `PUBLIC_BASE_URL` in `.env.local` — your cloudflared URL. Required; nothing can derive a tunnel. |
| Render | **Nothing.** Derived. Add `PUBLIC_BASE_URL` only for a custom domain. |

One note for any host that derives the URL: prefer a *stable production* domain
variable over a per-deployment one. `VERCEL_URL`, for instance, changes on every
push, so a preview deploy would hand Agora a URL that is already stale — which is
why the fallback above reads `VERCEL_PROJECT_PRODUCTION_URL` instead. And any
host with deployment-protection or an auth wall in front of it cannot work at
all: Agora and Vobiz arrive unauthenticated.

`/api/health` reports `publicBaseSource` and `servingHost`, so you can see which
of the three won without guessing.

### The trap: a deployed service carrying a tunnel URL

This has already happened here — a deploy was found carrying a developer's
`*.trycloudflare.com` URL. It is the nastiest failure in the project because
every check passes: the URL resolves, it looks legitimate, `/api/health` says
`ready: true`.

But the phones mutate game state in the *deployed* process while Agora fetches
`/api/llm` from the *laptop*, so the host is handed state for a room that does
not exist where it is looking. Nothing errors. The host just makes no sense.

`/api/health` now warns when `PUBLIC_BASE_URL`'s host differs from the host that
served the request. It is a warning and not blocking on purpose — a tunnel in
front of localhost mismatches legitimately, and so does a custom domain — so read
it in context. On a `*.onrender.com` request it means the env
var is wrong: unset it and let the host supply the value.

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

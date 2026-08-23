# Vobiz setup — step by step

Goal: a phone in the room rings when a contestant uses Phone a Friend.
Budget about 15 minutes. Do it in this order; each step depends on the last.

API reference: [VOBIZ.md](VOBIZ.md).

---

## 1. Account

<https://console.vobiz.ai> → sign up.

Indian number, because DLT/TRAI verification is smoother on one.

## 2. Copy the credentials — from the DASHBOARD

Console **home page** (`console.vobiz.ai/app` — click the vobiz logo top-left).
The docs are explicit: "your Auth ID and Auth Token are displayed directly on the
main dashboard."

- **Auth ID** — `MA_XXXXXXXX`
- **Auth Token** — a long secret

> **Do not use the SIP credentials page.** `console.vobiz.ai/app/sip/create-credentials`
> is a completely different credential system — username/password for
> authenticating SIP INVITEs from a softphone or a BYOC trunk. KKT never speaks
> SIP; it calls the REST API. Creating a SIP credential there gets you nothing
> and the values will not work as `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN`.
>
> (SIP trunking is only relevant to spec §9.8, the optional "judges can dial in
> and reach the agent" path. That is not the lifeline and not needed.)

Into `.env.local`:

```
VOBIZ_AUTH_ID=MA_XXXXXXXX
VOBIZ_AUTH_TOKEN=your-token
```

## 3. Buy a number — this is the step people skip

Console → **Phone Numbers** → **Buy Number**. Any Indian number is fine.

**`from` must be a number you actually own.** Vobiz rejects the call otherwise.
An Auth Token alone will not place a call — this is the single most common reason
the lifeline fails.

E.164 **without** the plus:

```
VOBIZ_FROM_NUMBER=911141XXXXXX
```

## 4. A fallback number

The number the lifeline dials when a contestant declines to give theirs — which
is a reasonable thing for a stranger at a hackathon to decline. Put **your own
handset** here so the demo always has something to ring.

With the plus, this one:

```
FALLBACK_FRIEND_NUMBER=+919XXXXXXXXX
```

## 5. Trial account — the likely blocker

If the console shows *"You are currently on a trial account — complete your first
recharge to convert to a full account and unlock all features"*, treat that as a
real gate, not a nag.

A wallet balance is **not** the same as a converted account. On a trial you may
find you cannot buy a number at all, which blocks step 3, which blocks
everything — `from` has to be a number you own.

So check, in this order:

1. Can you actually complete **Numbers → Buy Number**? If yes, the trial is not
   blocking you.
2. If it refuses, do the minimum recharge to convert the account, then buy.
3. Confirm outbound calling is enabled for the account.

Trial accounts are typically outbound-only, which is fine — the lifeline only
ever dials out.

## 6. Test the raw API before touching the game

Prove the carrier works before adding our code to the equation.

```bash
set -a; . ./.env.local; set +a
curl -X POST "https://api.vobiz.ai/api/v1/Account/$VOBIZ_AUTH_ID/Call/" \
  -H "X-Auth-ID: $VOBIZ_AUTH_ID" \
  -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"$VOBIZ_FROM_NUMBER\",\"to\":\"$FALLBACK_FRIEND_NUMBER\",
       \"answer_url\":\"$PUBLIC_BASE_URL/api/vobiz/answer?call=test\",
       \"answer_method\":\"POST\"}"
```

Expect `{ api_id, message, request_uuid }` and your phone ringing.

**A 200 only means queued.** If it returns 200 and nothing rings, the problem is
almost always the `from` number not being one you own, or no credit.

Pick up: you will hear the "call has already expired" apology, because `call=test`
is not a real lifeline. That is correct — it proves the webhook was reached and
returned valid XML.

## 7. Make the audio reachable

Two things have to be true, and both fail silently:

```bash
npm run render:audio    # writes public/audio/hints/*.wav
```

then confirm `PUBLIC_BASE_URL` is a real public https URL and open one clip in a
browser:

```
$PUBLIC_BASE_URL/audio/hints/r_nariyal_h1.wav
```

**Vobiz skips audio it cannot fetch, without erroring.** A wrong `PUBLIC_BASE_URL`
or a missing file means 45 seconds of dead air on a live call and nothing in any
log. `/api/health` checks the files are on disk; only your browser checks they are
reachable.

## 8. End to end

1. `/api/health` → no blocking items
2. Open the projector, join on a phone, start the round
3. Ask the host for a wire so one is active — the lifeline reads out the hint for
   the **active** wire, so without one there is nothing to read
4. Tap **Phone a Friend** on the handset
5. The host offers it: *"Chalis-paanch second lagenge. Pakka?"* — say **haan**
6. The phone rings. On answer: −45s, the handset mutes itself, the chyron goes live

## What happens when it fails

By design, visibly. If nobody answers, or the carrier rejects, or credit runs
out: **full refund, the lifeline goes back on the shelf, and the host says so out
loud.** Nothing is hidden.

So a Vobiz outage does not break the demo — it becomes the answer to "what
happens when your external API fails", which the brief explicitly asks about.

## Failure lookup

| Symptom | Cause |
|---|---|
| 200 but no ring | `from` is not a number you own, or no credit |
| 401 / 403 | Auth ID or Token wrong |
| Rings, then silence | Hint audio unreachable — check `PUBLIC_BASE_URL` in a browser |
| Never rings, no error | `to` not E.164, or trial outbound not enabled |
| Rings but clock never drops | `answer_url` unreachable, so `/api/vobiz/answer` never ran |
| Worked yesterday, not today | `cloudflared` restarted and `PUBLIC_BASE_URL` is stale |
| Cannot buy a number | Account still on trial — recharge to convert |
| Auth values rejected | You copied SIP credentials instead of the dashboard Auth ID/Token |

# Vobiz integration reference

Docs: https://www.vobiz.ai/docs/introduction · Console: https://console.vobiz.ai
Machine-readable: append `.md` to any docs page, or fetch
https://vobiz.ai/docs/llms-full.txt · MCP server: https://vobiz.ai/docs/mcp

Everything below was verified against the docs on 23 Aug 2026. What is
implemented in this repo lives in [lib/vobiz.ts](../lib/vobiz.ts) and
[app/api/vobiz/](../app/api/vobiz/).

---

## What Vobiz is, and why it matters here

Carrier-grade programmable telephony: real phone numbers in 130+ countries, SIP
trunking, outbound calls, IVR, WhatsApp Business API, and bidirectional
WebSocket audio. India-first — INR pricing, TRAI/DLT compliance, 140/1600
series numbers.

In this project it is the **second leg**: Agora carries the game in the room,
and Vobiz reaches the friend who is somewhere else with only a phone — the
**Phone a Friend** lifeline (spec §9).

## Auth

```
Base URL: https://api.vobiz.ai/api/v1
X-Auth-ID:    MA_XXXXXXXX
X-Auth-Token: <token>
Content-Type: application/json
```

Both come from the console. Capacity and subscription endpoints also accept a
Bearer token, which we do not use.

## Outbound call

`POST /Account/{auth_id}/Call/`

| Field | Notes |
| --- | --- |
| `from` | E.164, no plus. Must be a number you own. |
| `to` | Destination, or several separated by `<` (max 1000) |
| `answer_url` | Fetched **when the callee picks up**; must return Voice XML |
| `answer_method` | Default POST |
| `hangup_url` | End-of-call webhook |
| `ring_url` | Ringing webhook |
| `time_limit` | Seconds, default 14400 |
| `caller_name` | Up to 50 chars |
| `machine_detection` | `true` or `hangup` for AMD |

Returns `{ api_id, message, request_uuid }`. **A 200 only means queued** — real
state arrives on the webhooks.

## Voice XML verbs we use

`Speak`, `Play`, `Gather`, `Dial`, `Record`, `Stream`, `Redirect`, `Hangup`.
There is a visual builder at https://vobiz.ai/docs/xml-builder.

### Speak — and the Hindi problem

```xml
<Speak voice="WOMAN" language="en-GB">Text here</Speak>
```

Attributes: `voice` (`WOMAN` | `MAN`), `language`, `loop`.

**`Speak` has no Hindi voice.** Supported languages are European plus English
variants only. So:

- The **framing line** the friend hears first goes out in English. Fine — it is
  one sentence of "your friend needs a hint, listen carefully".
- The **hint itself** is Hindi, so it must be pre-rendered with Sarvam Bulbul and
  played with `<Play>`, which is language-agnostic. `npm run render:audio`
  produces these as **8 kHz mono WAV** into `public/audio/hints/`.
  WAV, not MP3: Sarvam returns WAV and Vobiz accepts it, so converting would
  mean an ffmpeg dependency for nothing.
- Bonus: the friend hears the *same voice* that is in the room.

Escape `&`, `<`, `>` in text nodes. `escapeXml()` in `lib/vobiz.ts` handles it.

### Gather

```xml
<Gather action="https://you/accept" method="POST" inputType="dtmf"
        numDigits="1" executionTimeout="15" finishOnKey="#">
  <Speak>Press 1 to accept.</Speak>
</Gather>
```

- The attribute is **`executionTimeout`** (5–60s), *not* `timeout`.
- `inputType`: `dtmf`, `speech`, or `dtmf speech`.
- Nested `Speak`/`Play` prompt the caller; the timer starts after they finish.
- Nest `Play` inside `Gather` to allow interruption by keypress.
- POSTs to `action`: `Digits`, `Speech`, `CallUUID`, `From`, `To`, `InputType`,
  `SpeechConfidenceScore`.

### Play

```xml
<Play>https://yourhost/clip.mp3</Play>
```

MP3 or WAV, fully qualified HTTPS, correct `Content-Type`
(`audio/mpeg` / `audio/wav`). Use 8 kHz mono for latency. **A file that cannot
be reached is silently skipped** — so a broken URL means dead air, not an error.

`loop` is `Play`'s **only** attribute. `loop="0"` repeats indefinitely until the
caller hangs up. We do *not* use it: `loop` leaves no gap between repetitions and
a hint replayed with no pause is hard to parse on a phone line. `hintLoopXml()`
emits explicit `Play` / `Wait` pairs instead, which also bounds the call to the
lifeline window without depending on `time_limit` firing on time.

`/api/vobiz/answer` checks the file exists on disk before returning the XML, and
falls back to a spoken apology if not — because we *can* check, and forty-five
seconds of silence on a live call is the worst available outcome.

## Callbacks — and one documented gap

`answer_url` is fetched **when the callee picks up**. That is the only signal we
treat as authoritative, and it is why the lifeline charges its 45s there.

Verified fields POSTed to the callback URLs, `application/x-www-form-urlencoded`:

| Field | Notes |
| --- | --- |
| `Event` | `Ring`, `StartApp`, `Hangup` |
| `CallUUID` | Unique call id — correlate on this |
| `From`, `To` | |
| `Status` | e.g. `completed` |
| `Duration` | Seconds |
| `StartTime`, `EndTime` | ISO 8601 |
| `Direction` | `outbound` |
| `auth_id` | |

> **UNVERIFIED (checked 23 Aug 2026):** the docs do **not** enumerate the values
> that indicate no-answer, busy, rejected, or carrier failure. `call-object` lists
> `hangup_cause_code`, `hangup_cause_name` and `hangup_source` as fields but not
> their possible values.
>
> So `app/api/vobiz/hangup/route.ts` deliberately does **not** branch on any
> status string. It infers failure structurally instead:
>
> ```
> the penalty was applied  ⟺  /api/vobiz/answer ran  ⟺  a human answered
> ```
>
> Reaching hangup without the penalty having been applied means the call was
> never answered, whatever the reason — so the team gets a full refund and their
> lifeline back. That is provable rather than guessed, and it cannot be broken by
> Vobiz adding a new cause string. The reported cause is logged for the host
> console and the write-up, never acted on.

## WhatsApp

`POST /messaging/messages`

```json
{
  "channel_id": "<uuid>",
  "waba_id": "<id>",
  "to": "+919876543210",
  "type": "text",
  "text": { "body": "..." }
}
```

Returns 201 with `status: "pending"`.

> **The gotcha that will bite you on demo day:** free-form messages only work
> inside a **24-hour window** after the user last messaged you. Outside it you
> need a **pre-approved template**, and approval is not same-day.

**Not used in KKT.** The post-game summary goes to each contestant's phone over
the existing SSE connection, which is instant, needs no template approval, and
does not require holding anybody's number past the end of the round. Documented
here only so nobody re-discovers the 24-hour window the hard way.

## Bidirectional WebSocket audio

Not used in this project, but this is the mechanism if you ever want a custom
pipeline on the phone leg.

```xml
<Stream bidirectional="true" keepCallAlive="true">wss://you/ws</Stream>
```

- **Inbound:** L16 PCM at 8 or 16 kHz, or μ-law at 8 kHz.
- **Outbound:** L16 at 8, 16 or 24 kHz, or μ-law at 8 kHz.
- The `start` event reports the actual inbound format in `mediaFormat` — read
  it rather than assuming.
- Media arrives as `{ event: "media", streamId, media: { payload: <base64> } }`.
- Send audio back with `playAudio`; payload must be **raw mono with no WAV or
  MP3 container header**.
- Chunk playback at 20–60 ms for responsive barge-in. 20 ms of mono L16 at
  16 kHz is 640 bytes before base64.
- `clearAudio` on the active `streamId` to cut playback when the caller
  interrupts. `checkpoint` to track completion.

**Do not use this to answer the primary conversation.** Requirement 1 says
Agora Conversational AI must carry the primary interaction, and there is no
documented way to inject a PSTN caller into an existing multi-party RTC channel
that already has three contestants in it.

## Other capabilities, not used here

SIP trunking and BYOC · SIP endpoints for softphones · conference calling with
per-member mute/kick · call transfer mid-call · recordings and CDR ·
sub-accounts · WebRTC SDK · answering-machine detection.

Native integrations exist for Vapi, Retell AI, ElevenLabs, LiveKit, Pipecat,
Bolna, Rapida AI, Ultravox and OpenAI Realtime — none of which we want, since
Agora has to be the brain.

SDKs for Python, Node.js, Ruby, Go, C#, Java and PHP at
https://github.com/vobiz-ai. This repo calls the REST API directly; one less
dependency, and the surface we need is three endpoints.

## Setup checklist

- [ ] Account at https://console.vobiz.ai, Auth ID and Auth Token copied
- [ ] **A purchased phone number** — `from` must be a number you own
- [ ] `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_FROM_NUMBER`,
      `FALLBACK_FRIEND_NUMBER` in `.env.local`
- [ ] One successful test call that actually rings your handset
- [ ] `PUBLIC_BASE_URL` reachable from the internet — Vobiz fetches
      `answer_url` from their servers, so localhost is invisible
- [ ] Trial accounts are **outbound-only**. Fine for us, but if you ever want
      inbound, unlock it in advance.
- [ ] Know that restarting `cloudflared` changes the tunnel URL, which
      invalidates `PUBLIC_BASE_URL` and silently breaks every webhook.

## Test without the agent

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$VOBIZ_AUTH_ID/Call/" \
  -H "X-Auth-ID: $VOBIZ_AUTH_ID" \
  -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"$VOBIZ_FROM_NUMBER\",\"to\":\"$EXPERT_PHONE_NUMBER\",
       \"answer_url\":\"$PUBLIC_BASE_URL/api/vobiz/answer?callId=test&summary=Test%20briefing\",
       \"answer_method\":\"POST\"}"
```

Your phone should ring, read the briefing, and offer to accept on keypress.
Get this working before you touch the voice agent.

## Reference index

| Topic | URL |
| --- | --- |
| Introduction | https://vobiz.ai/docs/introduction |
| Quick start | https://vobiz.ai/docs/quick-start |
| Authentication | https://vobiz.ai/docs/api-reference/authentication |
| Make a call | https://vobiz.ai/docs/call/make-call |
| Call object | https://vobiz.ai/docs/call/call-object |
| Applications | https://vobiz.ai/docs/applications |
| XML overview | https://vobiz.ai/docs/xml/overview/how-it-works |
| Speak | https://vobiz.ai/docs/xml/speak |
| Gather | https://vobiz.ai/docs/xml/gather |
| Play | https://vobiz.ai/docs/xml/play |
| Stream | https://vobiz.ai/docs/xml/stream |
| Audio streams | https://vobiz.ai/docs/audio-streams |
| WebSockets concept | https://vobiz.ai/docs/concepts/streaming-websockets |
| Callbacks | https://vobiz.ai/docs/concepts/callbacks |
| WhatsApp send | https://vobiz.ai/docs/whatsapp/api/send-message |
| Phone numbers | https://vobiz.ai/docs/account-phone-number |
| Errors | https://vobiz.ai/docs/errors |
| India compliance | https://vobiz.ai/docs/compliance/india/calling-regulations |
| Sarvam + Vobiz | https://docs.sarvam.ai/api/integration/build-voice-agent-with-vobiz |

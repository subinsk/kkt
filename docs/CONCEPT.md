# The build: a voice agent that draws what you say, then phones a human

Working name: **Fasal** (Hindi, *crop*). Track 1 — Agriculture & Rural
Communities.

---

## The pitch, in one breath

A farmer describes a sick plant out loud in Hindi. As they speak, a 3D plant on
screen turns yellow exactly where they said it was yellow. They correct it by
voice — "no, higher up" — and it moves. When the AI reaches the edge of what it
can safely confirm, it **phones a real agronomist**, reads them the case, and
texts the farmer a case number. Nobody repeats themselves to anybody.

## Why this is worth building

Most voice agents in this room will be a microphone attached to a chatbot. The
interesting question is not "can the AI talk" — it is **what can only exist
because the interface is voice**.

Here the answer is concrete: *a person who cannot read a form can still fill
one in, because they describe a picture and watch the picture change.*
Confirmation stops being "let me read that back to you" and becomes "look — is
this right?" That is a real accessibility mechanism, not a demo trick, and PS1
names both "low-literacy interfaces" and "voice-based data collection" as
innovation opportunities.

Then the case leaves the internet. Agora Recipes has 36 published demos and
**not one of them crosses onto the telephone network.** Vobiz is sitting right
there, sponsoring, with real PSTN.

## What each piece is doing, and why it has to be there

| Piece | Job | Why not something else |
| --- | --- | --- |
| **Agora ConvAI** | The whole conversation: barge-in, turn-taking, memory | Mandatory, and it is genuinely the best part of the stack |
| **Sarvam ASR + TTS** | Hindi and Hinglish, natively code-mixed | First-class vendor inside ConvAI — one config line |
| **Three.js** | The shared thing the farmer and AI are both looking at | A form cannot be filled by someone who cannot read it |
| **Vobiz PSTN** | Reaching the agronomist, who is in a field with a phone | The expert is not sitting in your web app |
| **Vobiz WhatsApp** | Written receipt with the case id | Voice is not a record |

Nothing here is decoration. Pull any one out and the story breaks.

---

## The demo, minute by minute

This is what you rehearse. The judges interact live, so the script is a spine,
not a cage.

**0:00 — Start.** Farmer opens the page. One button. Agent greets in Hindi.

**0:20 — Describe.** "Mere tamatar ke paudhe mein neeche ke patton pe peela pad
raha hai, aur chhote chhote hole bhi hain." The 3D plant's lower leaves go
yellow and pick up hole decals **while they are still talking**.

**0:40 — Correct by voice.** "Nahi nahi, upar wale patton pe zyada hai." The
yellowing moves up. The camera follows. *This is the moment. Let it land.*

**1:00 — Interrupt.** Cut the agent off mid-sentence with a new detail. It
drops what it was saying and takes the new thread.

**1:20 — Uncertainty.** Ask what pesticide to spray and how much. The agent
refuses to assert a dosage, says plainly that this needs a person, and offers
to call one.

**1:35 — The phone rings.** The agent calls the agronomist. **A handset on the
judges' table starts ringing.** Put it on speaker: a voice reads the case
summary and asks them to press 1. Press 1. The screen flips to *accepted*.

**2:10 — Receipt.** WhatsApp arrives with the case id and who is calling back.

**2:25 — The point.** Show the case: the farmer's own words, the structured
fields, the 3D annotation, the confidence gaps, the expert who took it. One
object, four networks, zero repetition.

The phone ringing in the room is the thing they will remember at judging.
Protect the time to build it.

---

## Architecture

```
  Farmer (browser, Hindi)
        │ WebRTC
        ▼
  Agora Conversational AI ── Sarvam ASR → LLM proxy → Sarvam TTS
        │                          │
        │                          │ tools
        │        ┌─────────────────┼──────────────────┬───────────────┐
        │        ▼                 ▼                  ▼               ▼
        │  annotate_plant   create_field_case    call_expert     notify_user
        │  set_view                │                  │               │
        │        │                 │              Vobiz PSTN    Vobiz WhatsApp
        │        ▼                 ▼                  │               │
        │   plant state ────▶ case object ◀───────────┘               ▼
        │        │                 │                            ☎ farmer
        ▼        ▼                 ▼
  Three.js scene (polled)    /view/[caseId]  ──▶  the agronomist opens this
                                                   while on the phone
```

The **case** is the product. It is assembled by voice, rendered in 3D, carried
to a human by telephone, and confirmed back over WhatsApp.

## The tool surface

Already built in this repo: `lookup_service_info`, `create_case`,
`escalate_to_human`, `call_expert`, `notify_user`.

To add for this concept:

| Tool | Effect |
| --- | --- |
| `annotate_plant(part, symptom, severity)` | Mutates the shared 3D state |
| `clear_annotation(part)` | Undo, for voice corrections |
| `set_view(part)` | Moves the camera so the farmer sees what is meant |

`part` is a small closed vocabulary — `lower_leaves`, `upper_leaves`, `stem`,
`fruit`, `roots`. Keep it small; the model picks reliably from five options and
badly from twenty.

---

## Three.js: what to build and what to avoid

### Build

- **A procedural plant.** Stem from a cylinder, leaves from a few bent planes
  or `LatheGeometry`, fruit from spheres. Roughly 60 lines.
- **Annotation as material state.** Symptom maps to colour and emissive
  intensity per leaf group. Yellowing is a lerp toward yellow; holes are an
  alpha-mapped texture or just small dark discs.
- **An audio-reactive ring** around the base, driven by a real `AnalyserNode`.
  `track.getMediaStreamTrack()` exists on Agora's base `ITrack`, so both the
  mic and the agent's voice give you a `MediaStreamTrack` you can wire into
  `AudioContext.createMediaStreamSource`. Blue when the farmer talks, green
  when the agent does.
- **Camera easing** with `damp3` on `set_view`. Movement reads as
  intentional; teleporting reads as a bug.

### Avoid

- **Downloaded GLTF models.** Licensing, file size, loader failures, and a
  black screen at 15:00. Procedural geometry cannot 404.
- **Physics, postprocessing, shadows.** Zero score, real risk.
- **Custom shaders**, unless you already write GLSL fluently.

### The one real risk

R3F under React 19 with Next's App Router: the canvas must be a client
component and should be dynamically imported with `ssr: false`. Get a spinning
cube on screen in the first twenty minutes; if the canvas is going to fight
you, you want to know before you have built the plant.

Verified compatible: `three@0.185.1`, `@react-three/fiber@9.7.0` (peer range
`react >=19 <19.3`, and we are on 19.2.8), `@react-three/drei@10.7.8`.

---

## Build order

Ship in this sequence. Each step is demoable on its own, so whenever the clock
runs out you still have something that works.

1. **Agora ConvAI in Hindi with Sarvam, barge-in tuned.** Already scaffolded.
   This is 45% of the score — do not move on until it feels good.
2. **`create_field_case` with spoken confirmation.** Requirement 6, done.
3. **Three.js plant + `annotate_plant`.** The differentiator on screen.
4. **`call_expert` via Vobiz.** The differentiator in the room. Already built —
   needs credentials and a purchased number.
5. **`/view/[caseId]`** so the expert has something to open.
6. **WhatsApp receipt.** Best effort only; see the caveat below.

**Hard stop at 14:15.** Last 45 minutes are rehearsal and the submission form,
which is 15 assets long.

## Known risks

- **WhatsApp needs an approved template** outside a 24-hour window after the
  user messages you, and approval is not same-day. Have the farmer message the
  business number first to open the window, or cut WhatsApp and read the case
  id aloud. The tool already fails soft and tells the agent to do exactly that.
- **Vobiz trial accounts are outbound-only.** Fine here — we only dial out —
  but confirm the number is purchased and a test call reaches your handset
  *before* the event.
- **Venue wifi.** Everything is realtime and three vendors deep. Have a phone
  hotspot as backup, and know that the tunnel URL changes if cloudflared
  restarts, which invalidates `PUBLIC_BASE_URL` and silently breaks tool calls.
- **Speaking Hindi under pressure.** If this is not comfortable, the same
  architecture works in English on Track 3 (civic complaints) — the plant
  becomes a map pin and a 3D street object.
- **Live phone call in a loud room.** Put the handset on speaker next to the
  laptop mic and be ready for it to sound rough. Have the screen state as the
  fallback proof.

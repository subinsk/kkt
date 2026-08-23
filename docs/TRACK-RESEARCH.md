# Track research and recommendation

Research done 23 Aug 2026, before the event. Sources: the participant brief,
Agora Conversational AI REST docs, Vobiz docs, Agora Recipes, and the
organiser's pre-event message.

---

## 1. Constraints that actually shape what you can build

These were found by reading the docs, and several of them quietly kill
otherwise-good ideas. Read this section before picking anything.

### Agora Conversational AI supports exactly one human per agent

From the `join` API reference, on `properties.remote_rtc_uids`:

> Currently, only one user ID is supported.

**This is the single most important constraint of the day.** Any concept
involving a group talking to one AI — group study, multiplayer game master,
community host, panel interview, town hall — is not directly buildable. You
would need one designated microphone and a fiction about whose voice it is.

This materially damages Track 4, whose brief is written almost entirely around
group experiences.

### Sarvam is a first-class ASR *and* TTS vendor inside Agora ConvAI

Both vendor allow-lists include `sarvam`. Sarvam covers Hindi, Bengali, Tamil,
Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia and Indian
English, has an auto-detect mode, and its models are explicitly built for
code-mixing — Hinglish and Tanglish are handled natively rather than as a
failure case.

This means a genuinely multilingual, code-switching agent is a config change,
not a research project. Given that 25% of the score is "voice-native
experience", this is the highest-leverage single setting available.

### Vobiz is PSTN, not another WebRTC vendor

Vobiz is carrier-grade telephony: real phone numbers in 130+ countries, SIP
trunking, programmable outbound calls, IVR XML verbs (`Speak`, `Gather`,
`Dial`, `Record`, `Stream`), WhatsApp Business API, and bidirectional WebSocket
audio (L16 PCM at 8/16/24 kHz, base64 in a JSON envelope).

It is India-focused — INR pricing, TRAI/DLT compliance, 140/1600 series
numbers.

### There is no Agora SIP gateway

Agora has RTMP gateway, media pull and media push, but nothing that terminates
SIP. So you **cannot cleanly bridge an inbound phone call into an Agora
channel** and have the Conversational AI Engine answer it.

That matters because requirement 1 says Agora ConvAI must carry the *primary*
interaction. If a phone caller talks to a Vobiz-side pipeline, Agora is not
central and the project does not qualify.

**Conclusion: Vobiz belongs on the second leg — the outbound call, the
escalation, the follow-up, the WhatsApp — not on the primary conversation.**
That is also the more interesting place to put it.

### What Agora Recipes already covers

36 published recipes. Already done: multilingual India guide (Bhaasha),
devotional assistant, voice tabletop RPG, wellness coach, movie discovery,
agent handoff between personas, cross-session memory, dynamic tool sets, RAG,
vision input, MCP tools, speaker lock.

**Nothing in the catalogue crosses into the telephone network.** Given the
organisers want to feature top projects on Recipes, building the thing that
isn't there yet is worth real points.

### Tooling: two options

- **Custom LLM proxy** (what this repo does) — you own the tool loop. Full
  control, works today.
- **`advanced_features.enable_tools` + an MCP server** — Agora invokes MCP
  tools itself. Less code, less control, one more moving part.

Stick with the proxy.

---

## 2. Track-by-track

### Track 1 — Agriculture & Rural Communities

**Impact ceiling:** highest of the four. **Innovation risk:** the brief's own
example scenario spells out Hindi → follow-up questions → code-switch →
retrieve → escalate → structured case. Expect several people to build exactly
that. Beating the brief's own example is the bar, not the goal.

Ideas:
- **Cross-network case triage** — farmer talks to the Agora agent, agent
  escalates by *actually phoning* an agronomist. See the recommendation below.
- **Voice-native cooperative ledger** — members log produce, quantities and
  rates by speaking; agent reads back and confirms before writing.
- **Scheme eligibility navigator** — dynamic questioning to narrow eligibility,
  refusing to assert anything unverified.
- **Proactive advisory callbacks** — the agent calls the farmer, not the other
  way round, when a weather or pest threshold trips.

### Track 2 — Collaborative Education

**Demo quality:** best of the four. A judge can *be* the student, which makes
interruption, adaptive difficulty and memory self-evident in 90 seconds.
**Innovation risk:** highest. Voice tutors and viva prep are the obvious
answer, and "collaborative" is mostly blocked by the single-user limit.

Ideas:
- **Adaptive viva examiner** — next question determined by the quality of the
  last answer; ends with a structured strengths/weaknesses report.
- **Socratic debugger** — student explains their bug aloud, agent refuses to
  give the answer and asks narrowing questions instead.
- **Oral language practice with correction memory** — tracks recurring mistakes
  across the session and re-tests them.

### Track 3 — Civic & Government Services

**Balance:** strong all-round. Real impact, clean external action, and the
brief hands you a safety restriction, which makes the 5% safety criterion easy
to argue explicitly. **Innovation risk:** moderate — structurally similar to
Track 1, and complaint-registration is a well-worn demo.

Ideas:
- **Voice replaces the form** — citizen describes a problem in Hinglish, agent
  asks only the questions the form actually needs, reads back, files it.
- **Department router** — the hard part is not the form, it is knowing which
  department. Make that the product.
- **Field-officer companion** — inspector dictates findings hands-free, agent
  structures them into a report.

### Track 4 — Live Communities & Interactive Experiences

**Innovation ceiling:** highest. **Feasibility:** worst. The single-user limit
blocks most of what the brief describes, a voice RPG is already a published
Agora recipe, and real-world impact is only 10% so the fun does not fully pay
for itself.

Only worth it if you have a genuinely strange single-player idea and are
confident you can make it feel alive. Otherwise it is a trap.

---

## 3. Recommendation: Track 1, built as a cross-network case system

### The one-line pitch

A farmer talks to an AI in Hindi; when the AI reaches the edge of what it can
safely confirm, it **picks up the phone and calls a human agronomist** — and
the farmer never repeats themselves to anyone.

### Why this one

- **It uses Vobiz as load-bearing infrastructure, not decoration.** The people
  who need to be reached — agronomists, KVK officers, cooperative secretaries —
  are in the field with a phone, not sitting in a web app. PSTN is the correct
  engineering answer, not a bolt-on. Judges can tell the difference.
- **Nothing in the Agora Recipes catalogue leaves the internet.** This is the
  gap, and the organisers are actively looking for projects to feature.
- **The demo has a physical moment.** A phone rings in the room. Judges score
  seven projects that day; one of them made a phone ring. That is 5% demo
  experience and a large slice of the 20% innovation.
- **Escalation stops being a checkbox.** Requirement 8 asks for a human
  escalation path. Most submissions will `console.log("escalated")`. Yours
  dials a number.
- **Code-switching is genuinely required here**, so Sarvam earns its place and
  the 25% voice-native score is defensible rather than asserted.
- **The safety story writes itself.** Pesticide dosage, chemical application
  and anything affecting a season's income are explicitly things the AI must
  refuse to assert and must escalate.

### Honest weaknesses

- The brief's own PS1 example describes most of this flow, so the baseline is
  crowded. The phone call, the WhatsApp receipt and the callback briefing are
  what separate you — build those, do not just build the diagnosis.
- It needs convincing spoken Hindi/Hinglish in the demo. If you are not
  comfortable improvising in Hindi under pressure, Track 3 gives you most of
  the same architecture in English.
- Two extra vendors means two extra things that can break on venue wifi.

### Architecture

```
Farmer (cheap Android browser, Hindi/Hinglish)
        │  WebRTC audio
        ▼
Agora Conversational AI  ── Sarvam ASR ─ LLM proxy ─ Sarvam TTS
        │                        │
        │                        ├─ lookup_advisory()      retrieval, admits gaps
        │                        ├─ create_field_case()    external action #1
        │                        ├─ call_expert()          external action #2  ── Vobiz ──▶ ☎ agronomist
        │                        └─ notify_farmer()        external action #3  ── Vobiz ──▶ WhatsApp
        ▼
   Case object: raw words + structured fields + confidence + open questions
```

The case is the product. It is created during the conversation, carried to the
expert by phone, and confirmed back to the farmer on WhatsApp.

### The four things to build, in order

1. **Agora ConvAI in Hindi with Sarvam, barge-in tuned.** Already scaffolded in
   this repo — swap `ASR_LANGUAGE` and the TTS vendor. Ship this first; it is
   the 45%.
2. **`create_field_case`** with mandatory spoken read-back and confirmation.
   This is requirement 6, already stubbed in `lib/tools.ts`.
3. **`call_expert` via Vobiz.** `POST /Account/{auth_id}/Call/` with an
   `answer_url` returning XML that `Speak`s the case summary in Hindi and
   `Gather`s a DTMF keypress to accept. On accept, mark the case claimed.
   **This is the demo's centrepiece — protect time for it.**
4. **`notify_farmer` via WhatsApp** with the case id and who is calling back.

### Stretch, only if 1–4 are solid by mid-afternoon

- **Expert briefing on pickup.** When the agronomist answers, before connecting
  them the agent summarises what the farmer said *and what it could not
  confirm*. The "nobody repeats themselves" promise, completed.
- **Proactive follow-up call** to the farmer to ask whether the remedy worked,
  logging the outcome. Genuinely novel; nobody else will have an agent that
  initiates contact.

### Explicitly out of scope

Bridging an inbound PSTN call into an Agora channel. There is no Agora SIP
gateway; the only routes are the self-hosted Linux Server Gateway SDK or a
headless-Chrome hack piping Vobiz WebSocket audio into the Web SDK. Both are
multi-hour rabbit holes with a real chance of ending the day with nothing, and
neither improves the score — Agora is already central on the primary leg.

---

## 4. Before the event

- [ ] Run the official quickstart end to end:
      https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs
- [ ] Agora credentials in `.env.local`, verified with a real call
- [ ] Sarvam API key, ASR and TTS both confirmed working in Hindi
- [ ] Vobiz account at https://console.vobiz.ai, **a purchased number**, and one
      successful test call to your own phone
- [ ] Note: Vobiz trial accounts are outbound-only. Inbound needs unlocking —
      sort this before the day if you need it.
- [ ] `cloudflared` installed and a tunnel tested
- [ ] Decide the demo phone. Ideally a second handset you can put on the table.

## 5. Reference links

- Brief: [PARTICIPANT-INFO.md](PARTICIPANT-INFO.md)
- Track selection form: https://forms.gle/oJSstjXYgfB3ikcD6
- Submission: https://www.commudle.com/builds/create?campaign=BuildWithAgora
- Agora ConvAI REST: https://docs.agora.io/en/api-reference/api-ref/conversational-ai/join
- Agora Recipes: https://recipes.agora.io/
- Vobiz docs: https://vobiz.ai/docs/introduction
- Vobiz XML `Stream`: https://vobiz.ai/docs/xml/stream
- Vobiz outbound call: https://vobiz.ai/docs/call/make-call
- Vobiz WhatsApp: https://vobiz.ai/docs/whatsapp/api/send-message
- Sarvam + Vobiz guide: https://docs.sarvam.ai/api/integration/build-voice-agent-with-vobiz
- Agora ESP32 client: https://github.com/AgoraIO-Conversational-AI/esp32-client

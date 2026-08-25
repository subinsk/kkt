# KAUN KATEGA TAARPATI (KKT)
### Technical & Design Spec — Build with Agora, Track 4
*Paanch taar. Chhe minute. Lock kiya jaye?*

---

## 1. The pitch

A projector shows a game-show set: **Amitabh bhai** on one side of a semi-circular desk, three contestants on the other, and a device with five wires and a live countdown between them. Three people scan a QR code, join on their phones, and become the contestants. Amitabh bhai asks Hinglish paheliyan. Each correct answer cuts one wire. Stuck? Use **Phone a Friend** — the game dials a real phone number, and a voice on the other end reads the hint, on loop, until the lifeline expires.

Five wires, six minutes, and a confetti charge that goes off if you lose.

**Why the quiz-show frame is load-bearing:** it isn't a joke wrapper. It supplies confirmation-before-irreversible-action (*"lock kiya jaye?"*), a native human escalation path (phone a friend), turn-taking discipline (the host addresses contestants by name), and a persona that makes the AI's personality requirement trivially satisfied.

> **Persona note:** Amitabh bhai is your own character with a Sarvam voice. Parody the *format*, not a specific real presenter — no cloned voice, no likeness, no name-dropping in the submission.

---

## 2. Audio routing — subscribe to everything, choose what to play

You asked for a four-way room: Amitabh bhai heard on all three phones and the spectator link, and every player heard by the agent and by the other devices. The architecture supports exactly that. The subtlety is that **all four participants are in the same physical room**, and that changes what you should actually *play* on each device.

### 2.1 The physics you can't code around

If Player 1 speaks and Player 2's phone plays that audio, Player 2 hears the same sentence twice: once through air at ~0ms, and again through the network at 150–250ms. That's not stereo, that's slapback echo, and it is genuinely disorienting. Worse, three phones with open mics and open speakers in one room is a positive feedback loop.

So the rule is:

> **Every client subscribes to every track. Each client decides independently which tracks to *play*.**

Playback is a per-client policy, not an architectural change. One config flag, three deployment modes, same codebase.

### 2.2 Channel membership

Five participants in one Agora RTC channel:

| Participant | Publishes | Subscribes | Plays |
|---|---|---|---|
| Phone A / B / C | mic | all | *(depends on mode)* |
| ConvoAI agent | agent audio | `remote_rtc_uids: [uidA, uidB, uidC]` | — |
| Spectator / projector | nothing | all | *(depends on mode)* |

The agent hears all three players. That part is unconditional and is what makes it a genuine group conversation rather than three separate dialogues.

### 2.3 The three modes

**Mode A — Co-located, room speaker.** *Recommended for demo day.*
- Phones: mic ON, play nothing.
- Projector laptop: plays the **agent track only** through room speakers.
- Players hear Amitabh bhai from the room. They hear each other through air. Judges standing around hear everything.
- One voice source in the room means no comb filtering and no phone-to-phone feedback.

**Mode B — Co-located, earbuds.** *Best isolation, if you have three pairs.*
- Phones: mic ON, play **agent track only**, into earbuds. Not other players — air already handles that.
- Projector: agent track at low volume, or muted with judges on the spectator link.
- Cleanest mic signal, best attribution, but judges need earbuds or their own spectator tab.

**Mode C — Remote / hybrid.** *Correct only when players are NOT in the same room.*
- Phones: play agent **plus** the other two players.
- Full conference. This is the mode that literally matches "heard on all three phones," and it's the right behaviour the moment someone joins from elsewhere.

```js
// one policy object drives all three modes
const POLICY = {
  A: { play: ["agent"],                 device: "speaker" },
  B: { play: ["agent"],                 device: "earbuds" },
  C: { play: ["agent", "players"],      device: "any"     }
};

client.on("user-published", async (user, mediaType) => {
  await client.subscribe(user, mediaType);              // always subscribe
  const isAgent = user.uid === AGENT_UID;
  const allowed = isAgent
    ? POLICY[mode].play.includes("agent")
    : POLICY[mode].play.includes("players");
  if (allowed) user.audioTrack.play();                  // selectively play
});
```

**Ship Mode A. Wire B and C behind the flag** — being able to say "it degrades to a room speaker and upgrades to full conference for remote players" is a better answer to a judge than any single hardcoded setup.

### 2.4 The agent hears itself — fix it twice

In Mode A the room speaker leaks into three open phone mics. Each phone's AEC can't help, because it isn't the device producing the sound. Stack two independent fixes.

**Capture ducking.** You know when the agent is speaking. Duck the phones, restore instantly.

```js
socket.on("agent_speaking", (isSpeaking) => {
  localAudioTrack.setVolume(isSpeaking ? 25 : 100);
});
```

Barge-in survives — a raised voice into a handset punches straight through a 25% floor.

**Self-echo transcript filter.** You know exactly what text you sent to TTS. If an inbound transcript matches the agent's own recent output, drop it before it reaches the LLM.

```js
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
function isSelfEcho(transcript, recentAgentUtterances) {
  const t = norm(transcript);
  if (t.length < 4) return false;
  return recentAgentUtterances.some(u => {
    const a = norm(u);
    return a.includes(t) || t.includes(a) || trigramSimilarity(a, t) > 0.6;
  });
}
```

Keep a 10-second rolling window. Cheap, and it removes most echo artifacts.

### 2.5 Who said that?

Agora mixes the channel; the transcript won't tell you which player spoke. **Check in hour one whether the RTM transcript payload carries a uid** — if it does, this whole subsection collapses to ten lines. Otherwise:

**Each phone reports its own mic level over websocket at ~30Hz.**

```js
setInterval(() => {
  socket.emit("level", { uid, level: localAudioTrack.getVolumeLevel(), t: Date.now() });
}, 33);
```

Server keeps a rolling 5s timeline per uid. On a final transcript, integrate each uid's level across the utterance window and take the argmax. Each person's own phone is closest to their own mouth, so the margin is wide.

```js
function attribute(startMs, endMs) {
  const scores = {};
  for (const [uid, samples] of levelTimeline) {
    scores[uid] = samples.filter(s => s.t >= startMs && s.t <= endMs)
                         .reduce((sum, s) => sum + s.level, 0);
  }
  const [best, second] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 0.5) return null;
  if (second && best[1] < second[1] * 1.4) return "contested";
  return best[0];
}
```

`"contested"` is a **feature, not a failure.** Feed it to the LLM and Amitabh bhai arbitrates: *"Do log ek saath bol rahe hain. Ek-ek karke — Rahul, pehle aap."* That's your multi-party turn-taking capability, demonstrated live, and judges will deliberately talk over each other to test it.

### 2.6 The design lever that beats the engineering

It's a quiz show, so **the host owns the floor.** Amitabh bhai addresses contestants by name, which serializes speech naturally and makes chaos opt-in. A conversation-design solution to what looks like an audio problem — worth saying out loud to judges.

**Hold-to-talk** stays on every phone as a manual override: holding boosts your gain and pins attribution to you. Use it for the final *"lock kiya jaye"* so the most consequential moment is never misattributed.

## 3. Spectator view (Three.js)

The projector is a **broadcast view** — the audience watches the show, contestants watch their phones.

**Set composition.** Semi-circular desk. Amitabh bhai seated stage-left facing the contestants. Three contestant seats stage-right in an arc. The device sits centre-stage on the desk between them. Studio lighting: warm key on the host, cool rim on the contestants, a hard spot on the device.

**Amitabh bhai model.** Stylized low-poly seated figure — you are not building a photoreal human in eight hours. What sells it is not the mesh, it's the behaviour:
- Emissive rim / subtle head bob driven by the agent's audio level
- Turns to face whichever contestant is currently attributed as speaking
- Leans forward under 60 seconds remaining
- Idle sway when nobody is talking

```js
// agent audio level, polled in the rAF loop
const level = agentAudioTrack.getVolumeLevel();   // 0..1
host.speakingIntensity = THREE.MathUtils.lerp(host.speakingIntensity, level, 0.25);
```

Read the level with an `AnalyserNode` off `getMediaStreamTrack()` if you want frequency detail — but **do not connect the analyser to `audioContext.destination`**, because Agora already plays the track and you'll get doubled audio. Call `audioContext.resume()` on the same click that starts the game.

**Contestant seats.** Three stylized figures. Each one **lights up when the attribution engine picks them**, which makes your diarization visible to the audience — a genuinely impressive thing for judges to watch working in real time. Nameplates from the join screen.

**The device.** Rounded box, five `TubeGeometry` wires from a terminal block, canvas-texture LED countdown, five status lamps.

**Wire cut (~400ms).** White emissive flash → swap the tube for two shorter curves → spark burst at the break → loose end droops. This is the payoff beat; make it feel good.

**Lower third.** Live captions of the current question and the last transcript, styled like a TV chyron. This carries the room when ASR is imperfect and makes the conversation legible to spectators standing at the back.

**Escalation.** Above 3:00 cool and calm. Under 1:00, red pulse on the beat, camera pushes in, bloom climbs.

**Performance.** Cap DPR at 2. Bloom on emissives only. Ship a `?minimal=1` flag that strips post-processing and particles — WebGL plus WebRTC plus screen-share on an unfamiliar laptop is a real framerate risk and you want a one-keystroke escape hatch.

---

## 4. Phone UI (contestant view)

Deliberately minimal — eyes belong on the big screen.

- Your name and seat colour
- Current question text (backup for when ASR or the room is loud)
- Five wire pips: intact / cut / deferred
- **Hold to talk** button (override)
- **Phone a Friend** button, greyed once spent
- Timer, synced from server

No WebGL on mobile.

---

## 5. Game rules

| Parameter | Value |
|---|---|
| Contestants | 3 (playable at 2–4) |
| Wires | 5 — red, blue, yellow, green, white |
| Clock | 6:00, server-authoritative |
| Wrong answer | −20s |
| Hint | −15s, host asks permission first |
| Phone a Friend | −45s, once per game |
| Defer a wire | free |
| Win | all five cut before 0:00 |
| Lose | confetti charge, then scoreboard |

**Tone:** a prank device planted in the office. Losing detonates confetti and revokes everyone's coffee-machine access for a week. The countdown supplies all the tension you need, and comedic stakes keep a bomb-defusal fiction comfortable inside a corporate venue. Amitabh bhai never discusses real device internals; if pushed, he deflects in character.

**Venue:** your participant doc says Paytm **Noida** (One Skymark, Sector 98). Set the fiction in whichever room you're actually sitting in — naming the real floor gets a laugh and costs nothing.

---

## 6. Not a fixed script — the eight behaviours

A riddle list is a script, and mandatory requirement #7 penalizes scripts. These are where your Conversational Depth score (20%) actually comes from. Build at least five.

| Behaviour | In play | Capability |
|---|---|---|
| Contestant-chosen wire order | "Blue wale ka batao" — riddle keyed to wire, not sequence | Dynamic flow |
| Diagnostic hints | Hint generated *from the wrong answer given*: "Nariyal nahi — aap food soch rahe ho. Neeche dekho." | Adaptive questioning |
| Arbitration | Attribution returns `contested` → host serializes the floor by name | Multi-party turn-taking |
| Deferral | "Chhodo, baad mein" → wire parked, host remembers to return | Session memory |
| Time negotiation | "Hint chahiye? Pandrah second lagenge. Bolo?" | Confirmation before consequence |
| Cross-wire callback | "Yehi jawab aapne teesre taar pe bhi diya tha." | Visible session memory |
| Panic register | Under 60s the host clips short; above 4:00 he's expansive | Adaptive style |
| Code-switching | Questions in Hindi, instructions in English, answers accepted in either | The marquee capability |

**Answer checking is semantic, never string matching.** `coconut` / `nariyal` / `naariyal` / "wo brown wala fruit" all pass. Let the LLM judge. A regex here will embarrass you in front of judges.

---

## 7. Architecture

```
  Phones (QR + number)      Host Laptop / Projector        Your Server
  ────────────────────      ───────────────────────        ───────────
  mic publish          ◄── websocket ──►  Three.js set     Node/Express
  30Hz level telemetry                    Agora RTC (recv)  ├─ game state (authoritative)
  hold-to-talk                            room speakers     ├─ server timer
  wire pips                               host console      ├─ level timeline + attribution
  phone-a-friend                                            ├─ /v1/chat/completions (custom LLM)
        │                                                   ├─ tool handlers
        │                                                   ├─ riddle bank (JSON)
        └────────── Vobiz inbound call ◄────────────────────┴─ Vobiz client

              Agora Conversational AI Engine
              ASR: Sarvam Saaras → LLM: your endpoint → TTS: Sarvam Bulbul
```

**Why a custom LLM endpoint:** it's the only way to inject authoritative game state into every turn. This is the spine of the build.

```js
messages.unshift({
  role: "system",
  content: `LIVE STATE — overrides anything you believe.
Time: ${s.secondsLeft}s
Intact: ${s.intact.join(", ")}   Cut: ${s.cut.join(", ")}   Deferred: ${s.deferred.join(", ")}
Active wire: ${s.activeWire ?? "none — ask which wire"}
Hints used: ${s.hintsUsed}   Phone-a-friend: ${s.lifelineUsed ? "SPENT" : "available"}
Last speaker: ${s.lastSpeaker ?? "unclear"}    ${s.contested ? "TWO PEOPLE SPOKE AT ONCE — serialize the floor." : ""}
Wrong answers so far: ${s.wrongAnswers.map(w => `${w.player}: ${w.text}`).join("; ")}
Contestants: ${s.players.map(p => p.name).join(", ")}`
});
```

The last three lines power arbitration, callbacks, and addressing people by name.

**Timer authority is server-side.** The LLM cannot count seconds and will hallucinate the clock if you let it try.

---

## 8. Tool contracts

```js
get_state()
  → full state object

select_wire({ color })
  → sets active wire, returns its riddle

cut_wire({ color, answeredBy })
  → ONLY on a semantically correct answer. Server validates, marks cut,
    fires the 3D animation.  → { success, wiresRemaining, secondsLeft }

penalize({ seconds, reason })
  → wrong answer or accepted hint. Server alone touches the clock.

phone_a_friend({ requestingPlayerId })
  → Vobiz outbound call.  → { callId, status }

finish_game({ outcome })
  → DB write, summary pushed to each phone, scoreboard render
```

**Cover the latency.** Use Agora's `filler_words` plus the custom-LLM `chat.completion.custom_metadata` first-chunk trick with `interruptable: false` to speak *"Ek minute… main taar trace kar raha hoon…"* while a tool resolves. In this game latency reads as suspense rather than lag — a free pass on the thing that usually damages voice demos.

---

## 9. Phone a Friend — the lifeline

Your external action, your human escalation path, and your Vobiz integration in a single mechanic. A phone ringing in the room is what judges will still be talking about at closing.

### 9.1 Why this does NOT go through Agora telephony

Agora's SIP/telephony surface is a **1:1 phone↔agent model** built for support hotlines and marketing campaigns:

- **Inbound**: a Vobiz number is imported into Agora and assigned to *one* published agent, which answers the call.
- **Outbound**: you create a **campaign**, download a CSV template, fill in numbers, upload it, and Agora processes the CSV and then dials.
- **SIP transfer**: hands the call *away* from the agent to a human destination — the agent leaves.

Two disqualifiers for a live lifeline. The campaign path is a batch workflow with CSV-processing latency, when you need a dial within ~2 seconds of a button press. And there's no documented way to inject a PSTN caller into an existing multi-party RTC channel that already contains three players, so the "friend's voice comes out of the room speakers" version isn't something to bet eight hours on.

**So: Agora ConvoAI owns the game. Vobiz Voice API owns the lifeline, called directly from your server.** Agora still carries the primary live voice interaction, which is what the centrality requirement asks for. No SIP trunk, no campaign, no number import needed for this path.

### 9.2 The flow

1. Player taps **Phone a Friend** on their handset. Once per game.
2. Amitabh bhai announces it in character: *"Lifeline use kar rahe hain? Theek hai — phone laga rahe hain."*
3. Server fires one Vobiz outbound call to that player's submitted number.
4. On **answer**: the −45s penalty starts, the on-screen countdown ring begins, and that player's mic is muted.
5. The callee hears a short framing line, then **the hint for the currently active wire, on loop** with a ~3s gap between repetitions.
6. At 45s the call ends with a sign-off. Mic restored, lifeline marked spent.
7. Player relays what they heard to the group — out loud, in the room, which keeps the group conversation intact.

```js
// server — single request, fully dynamic, no CSV
await fetch(`https://api.vobiz.ai/api/v1/Account/${AUTH_ID}/Call/`, {
  method: "POST",
  headers: { "X-Auth-ID": AUTH_ID, "X-Auth-Token": AUTH_TOKEN,
             "Content-Type": "application/json" },
  body: JSON.stringify({
    from: VOBIZ_DID,
    to:   player.phoneE164,                                  // +91XXXXXXXXXX
    answer_url: `${PUBLIC_URL}/vobiz/hint/${gameId}/${state.activeWire}`
  })
});
```

Your `answer_url` returns a call flow that plays the hint audio on repeat for the window.

### 9.3 Pre-generate the hint audio with Sarvam

Do **not** rely on telephony TTS. Render every hint ahead of the event with the same **Sarvam Bulbul** voice you use for Amitabh bhai, host them as static MP3s, and have the call flow `Play` the file on loop.

- Telephony-grade Hindi TTS is rough; a pre-rendered Bulbul clip is clean.
- Hearing the *same voice* on the phone that's in the room is a lovely continuity touch.
- Zero runtime TTS latency — the audio already exists when the button is pressed.

```
/audio/hints/r_coconut_h1.mp3
/audio/hints/r_coconut_h2.mp3
...
```

### 9.4 Penalty timing and failure handling

**Start the clock on `answer`, never on dial.** Indian mobiles ring for 3–8 seconds; charging the team for ring time feels broken and judges notice.

Wire Vobiz webhooks (call start / answer / hangup) into the game server:

| Event | Game effect |
|---|---|
| `initiated` | Chyron: "CALLING…", lifeline button locks |
| `answered` | −45s begins, countdown ring starts, player mic muted |
| `hangup` | Mic restored, ring clears, lifeline marked spent |
| `no_answer` / `busy` / `failed` | **Full refund**, Amitabh bhai says so in character, lifeline stays available |

Requirement #9 explicitly asks what happens when an external API fails. Handle it visibly, and write it up in the submission — it's cheap Safety points.

### 9.5 Mute the lifeline player

While the call is live, that handset's earpiece is inches from an open mic. If you don't mute, the hint audio leaks into the game channel and Amitabh bhai hears his own hint and reacts to it.

```js
socket.on("lifeline_active", ({ playerId, active }) => {
  if (playerId !== myId) return;
  active ? localAudioTrack.setEnabled(false) : localAudioTrack.setEnabled(true);
});
```

Hold-to-talk stays available if they want to relay before the call ends.

### 9.6 Consent and compliance

Numbers are entered by the player themselves on the QR landing page, behind an explicit consent checkbox. Held in session memory only, dropped at game end, never reused. Vobiz is TRAI-compliant and the DID is a real provisioned number — say this during the safety beat of the demo.

### 9.7 Stretch: a conversational friend

If Tier 1 is solid and there's time, the richer version dials an **actual friend outside the building**, reads them the question, captures their spoken answer, and has Amitabh bhai relay it: *"Aapke dost ne bola coconut. Lock kiya jaye?"* A real human injected into the loop with context preserved — the strongest possible reading of the escalation requirement.

Two routes, both needing verification:
- **Vobiz speech capture** in the call flow, POSTed back to the game server.
- **Agora ConvoAI outbound over a Vobiz SIP trunk**, giving the friend a real agent to talk to. Requires a non-campaign outbound trigger; the documented path is CSV campaigns, which is too slow. **Verify whether a single-call outbound REST API exists.**

> **Unverified — resolve in hour one.** The Vobiz Voice API `answer_url` verb set (Play / Speak / Wait / Redirect and the loop construct) is not covered by the SIP-trunking docs or the integration video. Vobiz's API shape mirrors Plivo's, which suggests Plivo-compatible XML, but confirm it. **Vikash Srivastava, Vobiz co-founder, is a listed speaker — ask him directly.** Fallback if it can't be resolved: display the hint on the requesting player's phone screen only, keep the −45s cost, and note the telephony path as future work.

### 9.8 If you also want the Agora SIP path (optional, ~15 min)

Not needed for the lifeline, but if you want judges to be able to *call a number and reach an agent*, the integration video shows the full flow. For India:

| Setting | Value |
|---|---|
| Agora origination URI (TCP/UDP) | `sip:sbc-ap-south.viblinx.com:5060` |
| Agora origination URI (TLS) | `sip:sbc-ap-south.viblinx.com:5061` |
| Transport | Must match on both sides — UDP works, and a mismatch fails **silently** |
| Agora vendor | `SIP Trunk` |
| SIP Trunk Address | the Vobiz outbound trunk's SIP domain |
| Username / Password | from the Vobiz credential list |

Outbound: Vobiz → create credential → create outbound trunk → copy SIP domain into Agora's Add Phone Number. Inbound: Vobiz → create origination URI with Agora's regional URI → create inbound trunk → link the number → in Agora, publish the agent and assign it under Deploy → Answer inbound calls. **The agent must be published or calls will not connect.** Reported end-to-end setup time is 3–4 minutes.

## 10. Endgame — win and loss sequences

The last four seconds are what the room remembers. Both outcomes are a choreographed audio + visual beat, driven by a single server event.

### 10.1 Audio assets

Drop your two recordings here, with exactly these names:

```
public/audio/outcome/
├── win.mp3                       # "Wah! Kya baat hai!" (recorded take)
└── lose.mp3                      # "Aag! Aag!" (recorded take)
```

Optional extras if you have time to record them — the code below no-ops cleanly if they're absent:

```
├── tick_final_ten.mp3            # ticking, last 10 seconds
└── wire_cut.mp3                  # short snip, per wire
```

```js
export const OUTCOME_AUDIO = {
  win:  "/audio/outcome/win.mp3",
  lose: "/audio/outcome/lose.mp3"
};
```

**Play them on the projector only.** One source in the room — three phones firing the same MP3 a few hundred milliseconds apart sounds terrible.

### 10.2 Two gotchas that will silently break this

**Autoplay policy.** Browsers block audio that isn't tied to a user gesture, and the endgame fires minutes after the last click. Preload and *unlock* both files on the same click that starts the game:

```js
const outcomeSfx = {};
function unlockOutcomeAudio() {                 // call from the Start button handler
  for (const [k, src] of Object.entries(OUTCOME_AUDIO)) {
    const a = new Audio(src);
    a.preload = "auto";
    a.volume = 0;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.volume = 1; }).catch(() => {});
    outcomeSfx[k] = a;
  }
}
```

**The agent will talk over it, or react to it.** Before the stinger plays, mute all three phone mics and stop the agent's current turn. Otherwise Amitabh bhai either speaks across your MP3 or hears "aag aag" through the open mics and responds to it.

```js
// server, on game end
io.emit("mute_all_mics", true);      // phones disable local audio track
await agora.interrupt(agentId);      // stop mid-utterance
io.emit("game_over", { outcome, secondsLeft, wiresCut });
// ...stinger plays on projector...
// then, after the sequence completes, let the host deliver a closing line
```

### 10.3 Loss — detonation

| t (ms) | Beat |
|---|---|
| 0 | Clock hits 0:00. LED panel goes solid red, freezes. |
| 0 | `lose_aag_aag.mp3` starts. |
| 80 | White flash overlay, full opacity → fades over 300ms. |
| 100 | Fireball: additive particle burst from the device, ~600 sprites. |
| 100 | Camera shake — decaying random offset, ~500ms. FOV punch 55 → 68 → 55. |
| 400 | Uncut wires whip outward. Device casing fragments scatter. |
| 800 | Fire settles into a burning plume on the desk; smoke particles drift up. |
| 1500 | Amitabh bhai turns to camera, unimpressed. Bloom drops. |
| 2500 | Chyron: **"PHAT GAYA"** — wires remaining, time survived. |
| 4000 | Scoreboard. |

Fire without any extra libraries — additive billboard particles with a radial-gradient canvas texture:

```js
// radial gradient sprite
const c = document.createElement("canvas"); c.width = c.height = 64;
const g = c.getContext("2d").createRadialGradient(32, 32, 0, 32, 32, 32);
g.addColorStop(0, "rgba(255,255,240,1)");
g.addColorStop(0.35, "rgba(255,170,40,0.9)");
g.addColorStop(1, "rgba(255,60,0,0)");
const ctx = c.getContext("2d"); ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);

const fireMat = new THREE.PointsMaterial({
  map: new THREE.CanvasTexture(c),
  size: 0.45, transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending, vertexColors: true
});
```

Per frame: drift each particle upward, add curl-noise turbulence on X/Z, shrink `size` over life, and ramp vertex colour white → yellow → orange → dark red → cull. Spawn the first 300 in a spherical burst with high outward velocity, then switch to a slow upward emitter for the plume.

**Keep it cartoonish.** Orange-and-yellow, confetti-adjacent, comic. The fiction is a prank device — a realistic detonation in a corporate office is the wrong note, and the comedy version is funnier and safer.

### 10.4 Win — defused

| t (ms) | Beat |
|---|---|
| 0 | Fifth wire cut. Timer **freezes**, does not reset — the surviving time is the score. |
| 0 | `win_wah_kya_baat_hai.mp3` starts. |
| 150 | LED panel flips red → green. All five status lamps go green in sequence, 80ms apart. |
| 300 | Key light warms. Bloom spikes then settles. |
| 400 | Confetti burst — instanced planes, gravity + tumble + drag. |
| 600 | Amitabh bhai leans back, applauds. Spotlight pushes in. |
| 1200 | Contestant seats pulse in their colours. |
| 2000 | Chyron: **"DEFUSED"** — time remaining, hints used, whether the lifeline was spent. |
| 3500 | Scoreboard, summary pushed to each phone. |

Confetti is cheaper than fire: one `InstancedMesh` of ~400 thin `PlaneGeometry` quads, random per-instance colour, velocity, and angular velocity. Integrate with gravity and a drag coefficient, tumble on all three axes, cull below the desk plane.

### 10.5 Sequencing with the host

Let the stinger finish before Amitabh bhai says anything. Fire his closing line from the server after the audio `ended` event, not on a fixed timeout — the delay reads as a beat rather than a bug, and it stops him stepping on your MP3.

```js
outcomeSfx[outcome].addEventListener("ended", () => {
  socket.emit("outcome_audio_done", { outcome });   // server → host closing line
}, { once: true });
```

Restore the phone mics only after the closing line, so the room can react without the agent trying to parse the cheering.

---

## 11. Host console

Hidden panel at `/host`:

- Pause / resume clock
- Force-cut a wire (disputed answer)
- Refund time
- Skip question
- Force-attribute the last utterance to a player
- Flip audio Tier 2 → Tier 1
- Kill agent / restart round

This satisfies "host or user control where relevant" **and** it's your insurance policy if the attribution engine misfires in front of judges. Build it early.

---

## 12. Riddle bank

Pre-write **20–25** Hinglish paheliyan, draw 5 per round so no two demos are identical.

```json
{
  "id": "r_coconut",
  "text_hi": "Bahar se sakht, andar se paani. Kaun hoon main?",
  "accept": ["coconut", "nariyal", "naariyal", "narial"],
  "near_miss": {
    "watermelon": "Paani to hai, par bahar se sakht nahi. Aur socho.",
    "egg": "Bahar sakht hai — par andar paani nahi, kuch aur hai."
  },
  "hints": [
    "Ye ek fruit hai.",
    "Mandir mein chadhaya jaata hai.",
    "Tod ke paani peete hain."
  ],
  "difficulty": 1
}
```

The `near_miss` map is what makes hints feel intelligent instead of canned — populate it for the eight most likely riddles. `hints[0]` is what Phone a Friend loops.

**Adaptive draw:** behind on the clock → difficulty 1; comfortably ahead → difficulty 3.

---

## 13. Eight-hour plan

**Pre-event — all of this before the 23rd:**
- Agora project (RTC + ConvoAI + RTM), Sarvam keys, Vobiz account + DID + one successful test call
- Custom LLM endpoint scaffold behind ngrok, tool loop working
- **Full Three.js set** — host, contestants, desk, device, wire-cut animation, LED timer, chyron. Biggest time sink; do not build it on the day.
- QR → room code → name + number join flow
- Riddle bank written, and **all hint MP3s pre-rendered with Sarvam Bulbul**
- **Record the two outcome stingers** — `win_wah_kya_baat_hai.mp3` and `lose_aag_aag.mp3` — into `public/audio/outcome/`
- README, architecture diagram, and the 15 submission assets as templates

**Event day:**

| Hours | Work |
|---|---|
| 0–1 | Agent joins, speaks as Amitabh bhai in Hinglish. Confirm morning problem statement. |
| 1–2 | **Audio topology.** Three phones publishing, laptop playing, ducking + self-echo filter. Get this stable before anything else. |
| 2–3 | Level telemetry + attribution engine. Contestant seats lighting up on the big screen. |
| 3–4 | Tool loop: `select_wire`, `cut_wire`, `penalize`. Semantic answer judging. |
| 4–5 | **Vobiz Voice API lifeline** — direct outbound call, pre-rendered Sarvam hint on loop, webhook-driven penalty. |
| 5–6 | The §6 behaviours — hints, deferral, callbacks, arbitration. This is your 20%; don't let it get squeezed. |
| 6–7 | Host console. Barge-in tuning (`silence_duration_ms` ~320–450, `interrupt_duration_ms` ~160). Three full rehearsals **in the actual room at actual noise levels.** |
| 7–8 | Demo video, README, diagram, Commudle submission, LinkedIn/X post tagging Agora and Vobiz. |

---

## 14. Live demo script (4 minutes)

1. **0:00** — Judges scan the QR. They are the contestants, not the audience. Names and numbers entered.
2. **0:20** — Amitabh bhai opens in Hinglish. Clock starts. First paheli.
3. **0:50** — **Interrupt him mid-sentence.** He stops and adapts. *(Voice-Native, 25%)*
4. **1:15** — Two judges answer at once on purpose. Attribution goes `contested`, host serializes the floor by name, seats light up on screen. *(Depth, 20%)*
5. **1:45** — Wrong answer. The hint references *that specific mistake*. *(Adaptive questioning)*
6. **2:15** — **Phone a Friend.** A phone rings in the room. Chyron goes live. *(External action + human escalation)*
7. **3:00** — Callback: *"Yehi jawab aapne pehle bhi diya tha."* *(Session memory)*
8. **3:20** — Final wire cut. Timer freezes, confetti, **"Wah! Kya baat hai!"** stinger. Summary lands on each phone.
9. **3:45** — Twenty seconds on the safety model: server-authoritative state, host override, consent-gated numbers, API-failure refund.

---

## 15. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Cross-device echo / self-hearing | **Critical** | Capture ducking + self-echo transcript filter. Tier 1 flag as escape hatch. |
| Attribution unreliable in a loud hall | **High** | Confidence threshold → `contested` → host arbitrates (feature, not bug). Hold-to-talk override. Host console force-attribute. |
| Vobiz Voice API `answer_url` verb set unknown | **High** | Ask Vikash Srivastava in hour one. Fallback: hint on the player's screen, same −45s cost. |
| Riddles read as a fixed script | **High** | §6 behaviours are the score, not decoration. |
| Hall noise breaks ASR | **High** | Rehearse in-room. Sarvam + Agora noise suppression. Chyron captions carry the room. |
| WebGL + WebRTC framerate | Medium | `?minimal=1`. |
| Outcome MP3 blocked by autoplay policy | Medium | Preload and unlock both files on the Start-button gesture. |
| Agent talks over the endgame stinger | Medium | Mute mics + `interrupt()` before playback; closing line fires on the audio `ended` event. |
| LLM hallucinates the clock | Medium | Server-authoritative state injected every turn. |
| Only 1–2 judges free | Low | Playable at 2. |
| Semantic judging too strict | Medium | Generous `accept` lists + host force-cut. |

---

## 16. Mandatory-requirements audit

| Requirement | How KKT meets it |
|---|---|
| Agora centrality | The entire game loop runs through Conversational AI Engine. Nothing functions without it. |
| Voice-native | Unplayable by text; the countdown makes speech the only viable input. |
| Live demo | Judges scan and play. |
| Interruption handling | Structurally guaranteed by time pressure; scripted into the demo at 0:50. |
| Conversation state | Deferred wires, wrong-answer history, cross-wire callbacks, per-player memory. |
| External action | Vobiz call, DB write, post-game summary to each phone. |
| Dynamic flow | Contestant-chosen wire order, adaptive difficulty, diagnostic hints, negotiation. |
| Human escalation | Phone a Friend to a real number, plus host console override. |
| Defined limitations | Host states what he can see, when he needs confirmation, what happens if the call fails. |
| 5+ capabilities | Barge-in · code-switching · multi-party turn-taking with attribution · noise handling · correction recovery · session memory **(6)** |

---

## 17. Open decisions

1. **Phone a Friend — looping hint or real friend?** Loop first, upgrade if time allows.
2. **Audio Tier 2 or Tier 3?** Tier 2 unless spectator audio stops mattering.
3. **How stylized is Amitabh bhai?** Low-poly and behaviourally alive beats detailed and static, every time.
4. **Does the RTM transcript carry a uid?** Check in hour one — if yes, the attribution engine becomes ten lines instead of eighty.

---

# 18. Amendments — decided during the build (23 Aug 2026)

These supersede the sections they name.

## 18.1 Five static riddles, not a 25-riddle bank *(supersedes §12)*

The riddle bank is **five fixed, very well-known Hindi paheliyan**, one permanently
bound to each wire:

| Wire | Riddle | Answer |
|---|---|---|
| laal / red | Bahar se sakht, andar se paani | nariyal |
| neela / blue | Saath chalti hai, pakad nahi sakte | parchhai |
| peela / yellow | Ek aankh hai, dekh nahi sakti | sui |
| hara / green | Kai parte hain, rula deti hai | pyaaz |
| safed / white | Jitna jiye utna chhota, roshni de aur roye | mombatti |

No random draw, no adaptive difficulty. **Why this is better here:** a judge who
*recognises* the riddle engages with the show, where an unfamiliar one stalls them
on the puzzle instead of the conversation — and the conversation is what is being
demoed. A fixed mapping also means the run-through you rehearse is the one you
demo, which is worth more than variety in a timed event.

Each riddle keeps its three static hints and its `nearMiss` map. `hints[0]` is the
line Phone a Friend loops, so it is written to stand alone without the riddle for
context. Implemented in `lib/game/riddles.ts`.

## 18.2 Interruption behaviour, specified *(refines §16)*

When a contestant cuts the host off, the host does this, in order, every time:

1. **Stops speaking immediately.**
2. **Listens** to what was actually said.
3. **Acknowledges it** in three or four words.
4. **Asks them to hear the question out** — *"Pehle sawaal suniye."*
5. **Re-asks the question from the start.**

The one exception: if what they said was an *answer*, he judges it rather than
re-asking. Previously the prompt said "answer the new thing and never restart the
sentence" — that reads as flustered. Returning to the question keeps the host in
control of the floor, which is the whole reason the quiz-show frame is
load-bearing.

## 18.3 Peer Talk — the contestants get a private channel *(supersedes §2.5 and most of §2.4)*

**The feature.** Every phone has a **Peer Talk** toggle, and it is **ON by
default**. While it is on, that contestant's mic is *not published to the Agora
channel* — the host literally cannot hear them, and they talk to the other two
contestants through the air, which is what people in a room do anyway. To speak
to Amitabh bhai, a contestant switches Peer Talk **off**; only then are they
audible. Discussion is free and costs no clock.

**Why this is the most important change in this document.** It collapses three of
the hardest problems in the spec:

- **Attribution (§2.5) mostly stops being a problem.** When exactly one
  contestant is live, whatever the ASR heard *is* that person — attribution is
  arithmetic, not inference. The level-telemetry engine stays as a fallback for
  when two or more go live at once, but it is no longer load-bearing, and the
  eighty-line version described in §2.5 is not needed for the common case.
- **Echo and feedback (§2.4) shrink with the number of open mics.** Most of the
  time one mic is open rather than three, so there is far less room-speaker
  leakage to duck and far less to filter.
- **`contested` becomes rarer but still real** — two people deliberately going
  live together is now an explicit act, which makes the arbitration beat in the
  demo script *more* legible, not less.

**What it costs.** The host has to be told who he can hear, or he asks a question
into a room that has muted itself and then wonders why nobody answered. So
`LIVE TO YOU: …` / `PEER TALK: everyone is discussing` is injected into LIVE STATE
every turn, and the prompt has a section telling him to wait rather than fill the
silence.

**Implementation.** `peerMode` on the player record, default `true`
(`lib/game/state.ts`); `setPeerMode` in the store emits an event and, when exactly
one contestant is live, sets the speaker directly. On the phone it is
`localAudioTrack.setEnabled(false)` — stronger than asking the model to ignore
someone, because there is nothing to ignore.

Hold-to-talk from §2.6 is now redundant and is dropped: "Peer Talk off" *is*
hold-to-talk, but latched, which is better for a discussion that runs for twenty
seconds.

## 18.4 Confirmed technical decisions

- **UI is Three.js**, on the projector view. Phones stay plain DOM — no WebGL on
  mobile, per §4.
- **LLM is Groq**, `llama-3.3-70b-versatile`, via the OpenAI-compatible endpoint.
  Chosen because time-to-first-token is what a room under a countdown actually
  perceives. Agora does **not** host an LLM, so a provider key is mandatory
  regardless. An Anthropic adapter is built and sits behind `LLM_PROVIDER` as the
  quality failover — flip one variable, restart, no code change.
- **ASR/TTS is Sarvam**: Saaras with `language: "unknown"` for auto-detection,
  which is the code-switching capability; Bulbul `abhilash` for the host voice.
- **Realtime transport is SSE + batched POST, not WebSocket.** Next.js route
  handlers cannot hold a WebSocket. Server→client is one SSE stream per client;
  client→server is a POST every 200ms carrying the ~6 mic-level samples collected
  since the last send. Thirty requests a second per handset was never necessary —
  the attribution maths integrates over a window and does not care about arrival
  rate.
- **`penalize({ seconds })` from §8 is replaced by `wrong_answer({ answer_text })`.**
  Passing the number through the model would hand it the clock, which §7 spends a
  paragraph forbidding. The server maps reason to cost.

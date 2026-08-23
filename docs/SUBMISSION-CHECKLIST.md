# Submission checklist

Submit at https://www.commudle.com/builds/create?campaign=BuildWithAgora

## The 15 mandatory assets

- [ ] 1. Working application or prototype
- [ ] 2. Public GitHub repository
- [ ] 3. README explaining the project and architecture
- [ ] 4. System architecture diagram
- [ ] 5. Three-to-five-minute demonstration video
- [ ] 6. Plan for the live demonstration
- [ ] 7. Detailed explanation of how Agora Conversational AI is used
- [ ] 8. List of external APIs, LLMs, speech providers, services used
- [ ] 9. List of demonstrated Conversational AI capabilities
- [ ] 10. Known technical limitations
- [ ] 11. AI limitations and safety considerations
- [ ] 12. Description of the target user
- [ ] 13. Clear explanation of the problem being solved
- [ ] 14. Description of at least one external action performed by the agent
- [ ] 15. Short explanation of future project evolution

Plus: share on LinkedIn or X, mentioning Agora.

## Mandatory behaviours to verify before demoing

- [ ] Agora Conversational AI carries the *primary* interaction, not a side feature
- [ ] Interrupting the agent mid-sentence works, and it picks up the new thread
- [ ] The agent uses something said 5+ turns earlier without being reminded
- [ ] At least one external action visibly lands (the actions panel)
- [ ] Questions change based on answers — not a fixed script
- [ ] Escalation to a human works and carries context forward
- [ ] The agent admits when something is unconfirmed instead of inventing an answer
- [ ] A failing tool produces a graceful spoken recovery, not silence

## Five conversational capabilities (need at least five)

The base ships with these; tick what you can actually demo:

- [ ] Barge-in — `turn_detection.start_of_speech.vad_config`
- [ ] Natural turn-taking — semantic end-of-speech detection
- [ ] Code-switching — prompt instruction + multilingual TTS voice
- [ ] Noise handling — AEC/ANS/AGC on the mic track
- [ ] Recovery from corrections — prompt instruction
- [ ] Silence handling — `parameters.silence_config`
- [ ] Confirmation before irreversible actions — prompt + `create_case`
- [ ] Explicit uncertainty — `lookup_service_info` returning `found: false`

## Demo plan template

1. **Setup (20s)** — who the user is, what they are stuck on.
2. **Natural opening (30s)** — speak messily, mid-sentence, mixed language.
3. **Interrupt (15s)** — cut the agent off deliberately. Call it out.
4. **Memory (20s)** — reference something from turn two without repeating it.
5. **Uncertainty (20s)** — ask something it cannot verify. It should say so.
6. **External action (40s)** — confirm, create the case, show the panel update.
7. **Escalation (20s)** — hand to a human, show context carried over.
8. **Close (15s)** — limits, what is next.

Rehearse it twice. Judges interact live, so know which inputs are fragile.

## Scoring weights — where the marks are

| Criterion | Weight |
| --- | --- |
| Voice-Native Experience | 25% |
| Conversational AI Depth | 20% |
| Innovation | 20% |
| Technical Implementation | 15% |
| Real-World Impact | 10% |
| Safety & Human Control | 5% |
| Demo & Product Experience | 5% |

45% is voice quality and conversational depth. Latency, barge-in
responsiveness, and not sounding like a read-aloud chatbot matter more than
feature count.

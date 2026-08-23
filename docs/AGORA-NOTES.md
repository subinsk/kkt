# Agora notes

Things the docs left ambiguous until somebody looked them up. Dated, so the next
session knows how stale it is. See `AGENTS.md` for the rule: never write Agora
from memory, fetch it.

## `llm.greeting_message` — 23 Aug 2026

Source: `POST /v2/projects/{appid}/join`,
<https://docs.agora.io/en/api-reference/api-ref/conversational-ai/join>
(fetched 23 Aug 2026; the `docs-md.agora.io` mirror 404s for this page, use
`docs.agora.io`).

- Type: string. **No documented maximum length.**
- It is **converted to speech by the TTS module directly** — it does *not* go
  through the LLM. So a greeting is deterministic: exactly the words you send are
  the words the room hears, with no turn spent and nothing invented.
- `greeting_audio_url` is a sibling field. If it is set, `greeting_message` is
  the fallback used when the audio fails to download or decode, and it is also
  what the system uses to estimate playback progress if the audio greeting is
  interrupted.

Why this mattered here: the whole opening — intro, rules, and the first riddle —
lives in `openingLine()` and rides in on `greeting_message`. That is only safe
because of the second bullet. If it went through the LLM, the rules would come
out differently at every rehearsal.

## Script: everything spoken is Devanagari — 23 Aug 2026

Bulbul runs with `target_language_code: hi-IN`. Handed Roman letters it
pronounces them **as English**, so "Paanch taar, chhe minute" comes out as a
phrasebook accent while "पाँच तार, छह मिनट" comes out clean. The riddles were
always Devanagari, which is exactly why they sounded right and every sentence
around them did not.

So the rule across the repo is: **spoken → Devanagari, displayed → Roman.**

| Text | Script | Why |
|---|---|---|
| `riddles.speak`, `riddles.hints`, `nearMiss` *values* | Devanagari | goes to TTS, via the host or via a pre-rendered WAV |
| `openingLine()`, `GREETING`, `failure_message`, outcome stingers | Devanagari | TTS'd verbatim, no model in the loop |
| everything the host says | Devanagari | the `# SCRIPT` block in `SYSTEM_PROMPT`, incl. English words spelled phonetically — लॉक, हिंट, फ़ोन अ फ्रेंड |
| `riddles.screen`, `WIRE_LABELS_HI`, all phone/projector UI | Roman | read with eyes, never spoken |
| `riddles.accept`, `nearMiss` *keys* | both | matched against what a contestant said, which can arrive in either |

Two couplings that fail silently if this drifts:

- `nearMiss` **keys** are substring-matched against the host's `wrong_answer`
  argument. The host now writes Devanagari, so a Roman-only key list matches
  nothing and every diagnostic hint quietly degrades to generic. Keep both
  scripts as keys.
- `hints[0]` is rendered straight to WAV for Phone a Friend, with no model to
  fix the script. `npm run check` asserts the whole bank is Latin-free.

**Still unknown:** whether a lone Latin word inside a Devanagari sentence (a
contestant's name from the join form, or the "On Air" button label) is read
cleanly. Both are deliberate and both are single tokens — listen for them in the
first rehearsal.

## `filler_words` phrases: 20 characters if non-Latin — 23 Aug 2026

Learned from a live `400`, not from the docs:

```
Invalid value at properties.filler_words.content.static_config.phrases:
Each phrase in filler_words.content.static_config.phrases containing CJK
or non-Latin characters must be at most 20 characters.
reason: InvalidFieldValue
```

The reference page for `POST /v2/projects/{appid}/join` documents only
"Maximum 100 filler words" and "Each filler word must not exceed 50 English
words" — it says nothing about this cap. **The 20-character rule is enforced but
undocumented.**

Two things that make it bite harder than it looks:

- It is a **whole-request rejection**. One over-long phrase 400s the entire
  `/join`, so the host never enters the room — it does not drop the phrase and
  carry on. On a projector thirty seconds before a demo it reads as "the game is
  broken".
- **Devanagari spends characters fast**, because matras are separate code
  points. "कंप्यूटर जी, जवाब दिखाइए..." is 27 characters and reads as four short
  words.

Phrases now live in `FILLER_PHRASES` in `lib/agent-config.ts`, all ≤16
characters, and `npm run check` measures every one of them.

Also confirmed on the same page, same date: no documented character limit on
`llm.greeting_message`, `llm.system_messages` or `llm.failure_message`.
`greeting_message` and `failure_message` support `{{variable_name}}` template
substitution. `greeting_audio_url` over 2048 bytes returns a 400. ASR and
interrupt keywords cap at 128 each.

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

**UNVERIFIED at runtime:** whether Sarvam Bulbul handles a single utterance that
mixes Roman Hinglish and Devanagari (our opening is Roman up to the last
sentence, then the riddle in Devanagari — `lib/game/riddles.ts` explains why the
riddle specifically must not be Roman). Listen for it in the first rehearsal; if
the Roman half is read as English, the fix is to send the whole opening in
Devanagari.

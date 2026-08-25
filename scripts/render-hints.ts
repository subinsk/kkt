/**
 * Pre-render the Phone a Friend hint audio with Sarvam Bulbul — spec §9.3.
 *
 *   npm run render:hints
 *
 * Run this once before the event, and again whenever a `hints[0]` line changes.
 *
 * Why pre-render at all: telephony-grade Hindi TTS is rough, a clip that already
 * exists costs zero latency at dial time, and the friend on the phone hears the
 * same voice that is in the room, which is a genuinely nice touch.
 *
 * 8 kHz mono, which is telephony bandwidth — asking Sarvam for 24 kHz and
 * sending it down a phone line only wastes bytes. WAV rather than MP3 so there
 * is no ffmpeg dependency; Vobiz accepts either.
 *
 * The hint that gets rendered is `hints[0]`, and it is written to stand alone —
 * the friend hears it without the riddle for context, so "Ye ek fruit hai"
 * would be useless and "Ye ek fruit hai jo mandir mein chadhaya jaata hai" is
 * not.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RIDDLES } from "../lib/game/riddles";

const OUT_DIR = join(process.cwd(), "public", "audio", "hints");
const SARVAM_TTS = "https://api.sarvam.ai/text-to-speech";

/** Any Latin letter at all — the tell that a line is not ready for an Indic voice. */
const HAS_ROMAN = /[A-Za-z]/;

/**
 * A safety net, not a step.
 *
 * The riddle bank is authored in Devanagari now, so the normal render makes no
 * model call at all and this returns its input untouched. It stays because the
 * failure it guards against is inaudible until it is on a phone line: one Roman
 * hint slipped into the bank and Bulbul reads the whole clip as English. If that
 * ever happens, the same model that runs the game fixes the script here rather
 * than shipping a mispronounced WAV.
 */
async function toDevanagari(lines: string[]): Promise<string[]> {
  if (!lines.some((line) => HAS_ROMAN.test(line))) return lines;

  console.warn(
    "  ! some hints are still Roman — transliterating before synthesis." +
      " Authoring them in Devanagari in lib/game/riddles.ts is the real fix.",
  );

  const key = process.env.LLM_API_KEY;
  const url =
    process.env.LLM_UPSTREAM_URL ??
    "https://api.groq.com/openai/v1/chat/completions";
  const model = process.env.LLM_MODEL ?? "openai/gpt-oss-120b";

  if (!key) {
    console.warn(
      "  ! LLM_API_KEY not set — sending Roman text to Bulbul, which will\n" +
        "    mispronounce it. Set the key and re-run for usable audio.",
    );
    return lines;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Transliterate Roman-script Hindi into Devanagari. Keep the meaning and word order identical. Keep English loanwords that Hindi speakers use as English words (fruit, birthday) in Devanagari phonetics. Return ONLY a JSON array of strings, same length and order as the input. No prose, no code fences.",
          },
          { role: "user", content: JSON.stringify(lines) },
        ],
      }),
    });
  } catch (err) {
    // A build host with no egress to Groq must not take the deploy down.
    console.warn(
      `  ! transliteration unreachable (${
        err instanceof Error ? err.message : err
      }) — using Roman.`,
    );
    return lines;
  }

  if (!res.ok) {
    console.warn(`  ! transliteration failed (${res.status}) — using Roman.`);
    return lines;
  }

  const json = (await res.json()) as {
    choices: { message: { content?: string } }[];
  };
  const raw = (json.choices[0]?.message?.content ?? "")
    .replace(/```(?:json)?/g, "")
    .trim();

  try {
    const parsed = JSON.parse(raw) as string[];
    if (Array.isArray(parsed) && parsed.length === lines.length) return parsed;
    console.warn("  ! transliteration returned the wrong shape — using Roman.");
  } catch {
    console.warn("  ! transliteration was not valid JSON — using Roman.");
  }
  return lines;
}

async function synthesise(
  text: string,
  opts?: { pace?: number; sampleRate?: number; loudness?: number },
): Promise<Buffer> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error("SARVAM_API_KEY is not set.");

  const res = await fetch(SARVAM_TTS, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      target_language_code: process.env.SARVAM_TTS_LANGUAGE ?? "hi-IN",
      // Same voice as the host in the room — that continuity is the point.
      speaker: process.env.SARVAM_TTS_SPEAKER ?? "abhilash",
      pitch: Number(process.env.SARVAM_TTS_PITCH ?? "-0.1"),
      // A shade slower than the host by default: a hint is heard once, over a
      // phone line, by someone with no context and no second chance.
      pace: opts?.pace ?? 0.88,
      loudness: opts?.loudness ?? 1.4,
      speech_sample_rate: opts?.sampleRate ?? 8000,
    }),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Sarvam ${res.status}: ${body.slice(0, 300)}`);

  const json = JSON.parse(body) as { audios?: string[] };
  if (!json.audios?.[0]) throw new Error("Sarvam returned no audio.");
  return Buffer.from(json.audios[0], "base64");
}

/**
 * The outcome stingers are NOT rendered here — spec §10.1.
 *
 * `public/audio/outcome/win.mp3` and `lose.mp3` are real recorded takes, and
 * they are committed. This script used to also synthesise a placeholder pair
 * (`win_wah_kya_baat_hai.wav` / `lose_aag_aag.wav`) in the host's own voice,
 * which was the right call while there were no real takes and the alternative
 * was a silent endgame. Now it only leaves two unreferenced files sitting in
 * the directory, reading as though something still plays them — and this is a
 * directory where a filename nobody reads is exactly how the endgame beat goes
 * quiet without anything erroring.
 *
 * If the mp3s ever go missing, `/api/health` says so loudly. That check is the
 * safety net; a regenerated placeholder is not.
 */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("\nRendering Phone a Friend hints with Sarvam Bulbul\n");

  const devanagari = await toDevanagari(RIDDLES.map((r) => r.hints[0]));

  let ok = 0;
  for (let i = 0; i < RIDDLES.length; i++) {
    const riddle = RIDDLES[i];
    const text = devanagari[i];
    const file = join(OUT_DIR, `${riddle.id}_h1.wav`);

    try {
      const audio = await synthesise(text);
      writeFileSync(file, audio);
      ok++;
      console.log(
        `  ok   ${riddle.wire.padEnd(6)} ${riddle.id.padEnd(14)} ${String(
          Math.round(audio.length / 1024),
        ).padStart(4)} KB`,
      );
      console.log(`       ${text}`);
    } catch (err) {
      console.log(
        `  FAIL ${riddle.wire.padEnd(6)} ${riddle.id} — ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  console.log(`\n${ok}/${RIDDLES.length} hints rendered into public/audio/hints/\n`);

  if (ok < RIDDLES.length) {
    console.log(
      "Vobiz SILENTLY skips audio it cannot fetch, so any missing hint is\n" +
        "forty-five seconds of dead air on a live call. Fix before rehearsing.\n",
    );
    // Non-zero locally, so a pre-rehearsal check fails loudly. But never break
    // a deploy over it: a game with no lifeline audio still plays, and a game
    // that failed to build does not.
    if (!ON_HOST) process.exit(1);
  }
}

/**
 * On a build host, nothing this script can hit — a missing key, a dead network,
 * a Sarvam outage — is worth failing a deploy over: the game plays without the
 * lifeline audio, and it does not play at all if the build never shipped.
 * Locally the same failure is loud, because that is a rehearsal blocker.
 */
const ON_HOST = Boolean(
  process.env.CI || process.env.RENDER || process.env.VERCEL,
);

main().catch((err) => {
  console.log(
    `\nrender-hints failed — ${err instanceof Error ? err.message : err}\n`,
  );
  if (!ON_HOST) process.exit(1);
  console.log("Continuing the build anyway; audio will be missing at runtime.\n");
});

import { optional, publicBaseUrl, required } from "./env";

/**
 * Vobiz: carrier-grade PSTN, and the second leg of the system. Agora carries
 * the conversation in the room; Vobiz reaches the friend who is somewhere else
 * with nothing but a phone.
 *
 * Verified against the docs — see AGENTS.md, which forbids writing this file
 * from memory. The failure mode that makes the rule worth having: an audio file
 * Vobiz cannot fetch is **skipped silently**, so a typo in a URL is dead air on
 * the call and an error precisely nowhere.
 */

const API_BASE = "https://api.vobiz.ai/api/v1";

function authHeaders(): Record<string, string> {
  return {
    "X-Auth-ID": required("VOBIZ_AUTH_ID"),
    "X-Auth-Token": required("VOBIZ_AUTH_TOKEN"),
    "Content-Type": "application/json",
  };
}

export type MakeCallResult = {
  api_id: string;
  message: string;
  request_uuid: string;
};

/**
 * Place an outbound PSTN call.
 *
 * One request, fully dynamic — no CSV and no campaign, which is exactly why the
 * lifeline goes through here rather than through Agora's telephony surface.
 *
 * A 200 only means the call was *queued*. Real state arrives on the webhooks.
 */
export async function makeCall(opts: {
  to: string;
  answerUrl: string;
  hangupUrl?: string;
  ringUrl?: string;
  callerName?: string;
  timeLimitSeconds?: number;
}): Promise<MakeCallResult> {
  const authId = required("VOBIZ_AUTH_ID");
  const res = await fetch(`${API_BASE}/Account/${authId}/Call/`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      // Must be a number you actually own. E.164 without the plus.
      from: required("VOBIZ_FROM_NUMBER"),
      to: opts.to,
      answer_url: opts.answerUrl,
      answer_method: "POST",
      hangup_url: opts.hangupUrl,
      ring_url: opts.ringUrl,
      caller_name: opts.callerName?.slice(0, 50),
      time_limit: opts.timeLimitSeconds ?? 300,
    }),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Vobiz call failed (${res.status}): ${text}`);
  return JSON.parse(text) as MakeCallResult;
}

/** Ampersands and angle brackets inside XML text nodes must be escaped. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The call flow the friend hears — spec §9.2, steps 5 and 6.
 *
 * Structure: a short English framing line, then the pre-rendered Hindi hint on
 * repeat with a gap between repetitions, then a sign-off.
 *
 * On the repetition: `Play` does have a `loop` attribute, and `loop="0"` loops
 * indefinitely — but `loop` gives no gap between plays, and a hint repeated with
 * no pause is hard to parse on a phone line. So we emit explicit Play/Wait pairs
 * instead, which also bounds the call to the lifeline window without depending
 * on `time_limit` firing on time.
 *
 * The framing line is in English because `Speak` has **no Hindi voice** — its
 * languages are European plus English variants. That is also why the hint itself
 * is a pre-rendered Bulbul MP3 played through `Play`, which is language-agnostic.
 * Bonus: the friend hears the same voice that is in the room.
 */
export function hintLoopXml(opts: {
  audioUrl: string;
  /** Roughly how long the hint window should last, in seconds. */
  windowSeconds?: number;
  gapSeconds?: number;
}): string {
  const window = opts.windowSeconds ?? 45;
  const gap = opts.gapSeconds ?? 3;
  // Assume a hint clip of about four seconds; one repetition is clip + gap.
  const perRepetition = 4 + gap;
  const repetitions = Math.max(2, Math.floor(window / perRepetition));

  const loop = Array.from(
    { length: repetitions },
    () => `  <Play>${escapeXml(opts.audioUrl)}</Play>\n  <Wait length="${gap}"/>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="MAN" language="en-GB">Hello! You are on Kaun Katega Taarpati. Your friend needs a hint. Listen carefully, then tell them.</Speak>
${loop}
  <Speak voice="MAN" language="en-GB">That is all the time we have. Good luck!</Speak>
  <Hangup/>
</Response>`;
}

/**
 * Fallback flow for when something is wrong with the hint audio.
 *
 * Worth having precisely *because* a missing MP3 is silent: if we know the file
 * is not there, saying something is far better than forty-five seconds of
 * nothing while the room watches a countdown ring.
 */
export function simpleSpeakXml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="MAN" language="en-GB">${escapeXml(message)}</Speak>
  <Hangup/>
</Response>`;
}

export const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8" };

/** Where Vobiz should call us back. Must be publicly reachable. */
export function publicUrl(path: string): string {
  return `${publicBaseUrl()}${path}`;
}

export const FALLBACK_FRIEND = () => optional("FALLBACK_FRIEND_NUMBER", "");

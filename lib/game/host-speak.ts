/**
 * Make the host say an exact line, from server code.
 *
 * Routed through this app's own `/agent` endpoint rather than importing the
 * Agora helper directly, because that route owns the map of which agent is
 * running in which room. One owner, one source of truth.
 *
 * Every call is fire-and-forget. These are announcements — a call connecting, a
 * call ending — and none of them is worth failing a webhook over. If the host
 * misses one the game is still correct; if a Vobiz webhook 500s because a TTS
 * call was slow, the lifeline breaks.
 */

import { optional, resolvePublicBase } from "../env";

/** Reach our own API, whatever host we happen to be running on. */
function selfOrigin(): string {
  const { url } = resolvePublicBase();
  if (url) return url;
  return `http://127.0.0.1:${optional("PORT", "3000")}`;
}

export function hostSay(
  code: string,
  text: string,
  opts?: { interruptable?: boolean },
): void {
  void fetch(`${selfOrigin()}/api/room/${encodeURIComponent(code)}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "speak",
      text,
      // These land in the middle of something else happening, so they are not
      // interruptable by default — a half-spoken "the call is connected" is
      // worse than none.
      interruptable: opts?.interruptable ?? false,
    }),
  }).catch(() => {
    // Announcements are best-effort by design. See the note above.
  });
}

/**
 * The two lines that bracket a lifeline call.
 *
 * Deterministic rather than generated, for two reasons. They have to be exactly
 * on time — the moment the friend picks up, and the moment they hang up — and a
 * model asked to narrate a phone call it cannot hear will invent details about
 * it. Devanagari, like everything else spoken.
 */
export const LIFELINE_LINES = {
  connected: "फ़ोन जुड़ गया। ध्यान से सुनिए — घड़ी चल रही है।",
  ended: "कॉल पूरी हुई। बताइए, आपके दोस्त ने क्या कहा?",
  failed: "फ़ोन नहीं लगा। कोई बात नहीं — समय वापस कर दिया, लाइफ़लाइन आपकी अभी भी है।",
};

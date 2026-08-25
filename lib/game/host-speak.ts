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
import type { SpeakPriority } from "../agora-rest";

/** Reach our own API, whatever host we happen to be running on. */
function selfOrigin(): string {
  const { url } = resolvePublicBase();
  if (url) return url;
  return `http://127.0.0.1:${optional("PORT", "3000")}`;
}

export function hostSay(
  code: string,
  text: string,
  opts?: { interruptable?: boolean; priority?: SpeakPriority; register?: boolean },
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
      /**
       * Queue behind the sentence in progress; never cut across it.
       *
       * This is the fix for a bug that read as the host skipping words. Agora
       * defaults `/speak` to `INTERRUPT` — "immediately interrupts the current
       * interaction" — so every one of the three lines below arrived by
       * destroying whatever the host was saying, usually mid-riddle. The room
       * heard half a question and the screen jumped to the announcement.
       *
       * `interruptable: false` above does NOT cover this. It protects the line
       * we are about to say from being cut off by the room; it says nothing
       * about the line we are cutting off to say it.
       *
       * The two spoken lines are seconds long and the call they bracket runs
       * forty-five, so waiting for the current sentence to finish costs nothing
       * anyone will notice.
       */
      priority: opts?.priority ?? "APPEND",
      /**
       * Whether the route should add this to the utterance ledger.
       *
       * False exactly once: when the ledger's own watchdog is re-speaking a line
       * it has already recorded as a retry. Letting the route register it again
       * would create a second, untracked record of the same words — so the retry
       * would look like a fresh line, its `attempts` counter would reset, and it
       * could be retried forever.
       */
      register: opts?.register ?? true,
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

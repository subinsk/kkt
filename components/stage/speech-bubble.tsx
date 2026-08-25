"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
// The speaking threshold is shared with the phone's capture ducking, so the two
// can never disagree about whether the host is talking.
import { AGENT_SPEAKING_LEVEL } from "@/lib/use-agora";
// Long lines are cut into cards there rather than here, so the splitting can be
// asserted by `npm run check` without a WebGL context.
import {
  advanceReveal,
  charsPerSecondFor,
  cueAt,
  newReveal,
  toCues,
} from "@/lib/subtitles";
import type { HostLine } from "@/lib/use-host-line";

/**
 * What Amitabh bhai is saying, as a speech bubble above his head.
 *
 * Why it earns its place: the host is the only character with a face and he has
 * no mouth animation, so without this the audience has no visual confirmation
 * that the voice in the room belongs to the figure on screen. The bubble ties
 * them together.
 *
 * It also carries the room when the ASR or the PA is fighting a noisy hall — a
 * spectator at the back who cannot make out the audio can still follow the game.
 *
 * # The sync problem this solves
 *
 * The text and the audio arrive from two different places at two different
 * times. `host_said` is emitted by the LLM proxy the instant the model finishes
 * a turn — *before* the reply is even handed to Agora, which then has to run it
 * through Sarvam TTS and stream the result back into the channel. That is
 * anywhere from a few hundred milliseconds to a couple of seconds of nothing.
 *
 * So the text is never the cue. The AUDIO is the cue: `levelRef` carries the
 * host's live output level, read off the RTC track every 60ms, and this
 * component does nothing at all until that level says he has actually opened his
 * mouth. Same at the other end — the bubble finishes when the audio stops, not
 * when a timer says it should.
 *
 * Between those two edges we still have to guess, because Agora gives us no
 * word timings, only a level. The guess is deliberately biased slow (see
 * `HOLD_FRACTION`): a subtitle that lags the voice slightly reads as a subtitle,
 * and one that runs ahead reads as broken — and worse, spoils the riddle.
 *
 * Rendered with drei's `Html`, so it is real DOM projected into the 3D scene —
 * crisp at projector scale, where canvas text is not.
 */

export function SpeechBubble({
  line,
  status = null,
  wordsPerSecond = null,
  levelRef,
  onDone,
  position = [0, 1.62, -1.5],
}: {
  /**
   * The line the host is saying. Null hides the bubble.
   *
   * Carries an id rather than being a bare string, and the id is what the change
   * detector compares. Two reasons, both bugs that were visible on stage: a
   * repeated line is character-for-character identical to the one before it — the
   * prompt tells the host to re-ask a question from the start after an
   * interruption — so a string comparison saw no change and never re-revealed
   * it. And a queue cannot exist without identity: `lib/use-host-line.ts` needs
   * to know which line this is in order to know when to hand over the next.
   */
  line: HostLine | null;
  /**
   * The ledger's status for this line, when somebody is reporting acks.
   *
   * This is the better cue and it replaces the level threshold when present.
   * `speaking` means Agora's own transcript says TTS has started for this turn —
   * a fact, where the level was an inference from a smoothed reading of the
   * received stream, computed independently on every screen. Null means nobody
   * is reporting and the level is all we have, which is the pre-ledger
   * behaviour and still correct.
   */
  status?: string | null;
  /** The measured speaking rate from the ledger, if there is one yet. */
  wordsPerSecond?: number | null;
  /** The host's live output level, 0..1. The fallback cue when there are no acks. */
  levelRef: React.RefObject<number>;
  /**
   * Called once, when this line has been revealed and has finished lingering.
   *
   * This is what advances the queue, and it has to come from here rather than
   * from a timer upstream: the reveal ends when the *audio* stops, and the level
   * ref is only read in this component's frame loop.
   */
  onDone?: () => void;
  position?: [number, number, number];
}) {
  const text = line?.text ?? null;
  const cues = useMemo(() => (text ? toCues(text) : []), [text]);
  const charsPerSecond = useMemo(
    () => (text ? charsPerSecondFor(text, wordsPerSecond) : 0),
    [text, wordsPerSecond],
  );

  const [shown, setShown] = useState("");
  const [visible, setVisible] = useState(false);
  const [typing, setTyping] = useState(false);

  /**
   * The pacing state, in a ref rather than in React state.
   *
   * It is touched every frame; the three values that actually reach the DOM are
   * pushed out only when they change, which works out at roughly one render per
   * character revealed — the same budget the old per-character timers used, with
   * none of their drift.
   */
  const run = useRef({
    /**
     * The id of the line being revealed, NOT its text.
     *
     * This one field is the whole repeated-line fix. Comparing text meant that
     * the host re-asking a question — which the prompt requires after an
     * interruption — looked like no change at all, so the reveal never restarted
     * and the second ask was spoken with an empty bubble above it.
     */
    id: null as number | null,
    reveal: newReveal(),
    /** Set once `onDone` has fired, so it fires exactly once per line. */
    reported: false,
  });

  useFrame((_state, delta) => {
    const r = run.current;
    // A backgrounded tab hands back one enormous delta on return. Clamping it
    // stops the whole line fast-forwarding in a single frame.
    const dt = Math.min(delta, 0.1);

    if (r.id !== (line?.id ?? null)) {
      r.id = line?.id ?? null;
      r.reveal = newReveal();
      r.reported = false;
      if (visible) setVisible(false);
      if (shown) setShown("");
      if (typing) setTyping(false);
    }

    if (!text) return;

    /**
     * Is he speaking right now? The audio decides — always.
     *
     * This was briefly gated on the ledger's `status` instead, and that was
     * wrong in an instructive way. The acks are authoritative about *what* was
     * said and *whether it was cut off*, but they are measured to arrive only at
     * the END of a turn — there is no in-progress transcript and no agent-state
     * event on this stack (25 Aug 2026, see docs/AGORA-NOTES.md). So gating on
     * `status === "speaking"` meant the reveal could not start until the line had
     * already finished being spoken.
     *
     * The output level, by contrast, is the audio: it is read off the very stream
     * the room is hearing, sixty times a second. Nothing can be better
     * synchronised than that, because it *is* the thing being synchronised to.
     *
     * So the division of labour is: the level says WHEN, the ledger says WHAT.
     * `status` is still used — an `interrupted` line is handed down already
     * truncated to what was actually spoken, so the reveal runs out of characters
     * in the right place instead of guessing at it.
     */
    const voiced = (levelRef.current ?? 0) > AGENT_SPEAKING_LEVEL;

    const { visible: nowVisible, done } = advanceReveal(r.reveal, {
      dt,
      voiced,
      cues,
      total: text.length,
      charsPerSecond,
    });

    // Nothing is drawn until he has actually been heard.
    const wantVisible = r.reveal.started && nowVisible;
    if (wantVisible !== visible) setVisible(wantVisible);

    const { shown: nextShown } = cueAt(cues, Math.floor(r.reveal.cursor));
    if (nextShown !== shown) setShown(nextShown);
    if (!done !== typing) setTyping(!done);

    /**
     * Hand the queue back, once.
     *
     * The condition is "revealed, and finished lingering" — `nowVisible` going
     * false after `started` is exactly the linger expiring in `advanceReveal`.
     * Reported from inside the frame loop because that is where the audio is
     * observed; upstream has no way to know the voice has stopped.
     */
    if (!r.reported && r.reveal.started && !nowVisible) {
      r.reported = true;
      onDone?.();
    }
  });

  if (!visible || !text) return null;

  return (
    <Html
      position={position}
      center
      // Scales with camera distance, so it stays legible as the camera pushes
      // in under a minute and while the user is dragging the view around.
      distanceFactor={4.2}
      // Never intercept a drag — the camera is orbitable and this sits right in
      // the middle of the frame.
      style={{ pointerEvents: "none", userSelect: "none" }}
      zIndexRange={[10, 0]}
    >
      <div
        style={{
          // Fixed box. The card count absorbs a long line, not the bubble size —
          // a bubble that grows with the text covers the wire panel behind it.
          width: "22rem",
          minHeight: "3.4rem",
          boxSizing: "border-box",
          padding: "0.7rem 0.95rem",
          background: "rgba(12, 10, 8, 0.92)",
          border: "1px solid rgba(201, 151, 63, 0.55)",
          borderRadius: "0.65rem",
          // The tail. A bordered square rotated 45° and clipped by the bubble
          // body above it — cheaper and sharper than an SVG pointer.
          position: "relative",
          boxShadow: "0 8px 30px rgba(0,0,0,0.55)",
          backdropFilter: "blur(2px)",
        }}
      >
        <div
          style={{
            fontSize: "0.5rem",
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#c9973f",
            marginBottom: "0.3rem",
            fontWeight: 600,
          }}
        >
          Amitabh bhai
        </div>

        <div
          style={{
            fontSize: "0.95rem",
            lineHeight: 1.35,
            color: "#f2ece2",
            fontWeight: 500,
            // A single unbroken token — a URL, a mangled transcript — must wrap
            // rather than push the card wider than the box it is drawn in.
            overflowWrap: "anywhere",
          }}
        >
          {shown}
          {typing && (
            <span
              style={{
                display: "inline-block",
                width: "0.45em",
                height: "1.05em",
                marginLeft: "0.08em",
                background: "#c9973f",
                verticalAlign: "text-bottom",
                animation: "kkt-caret 0.75s steps(2, jump-none) infinite",
              }}
            />
          )}
        </div>

        {/* Tail, pointing down at the host. */}
        <div
          style={{
            position: "absolute",
            bottom: "-0.36rem",
            left: "50%",
            transform: "translateX(-50%) rotate(45deg)",
            width: "0.7rem",
            height: "0.7rem",
            background: "rgba(12, 10, 8, 0.92)",
            borderRight: "1px solid rgba(201, 151, 63, 0.55)",
            borderBottom: "1px solid rgba(201, 151, 63, 0.55)",
          }}
        />

        <style>{`
          @keyframes kkt-caret {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>
      </div>
    </Html>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Html } from "@react-three/drei";

/**
 * What Amitabh bhai is saying, as a speech bubble above his head.
 *
 * Why it earns its place: the host is the only character with a face and he has
 * no mouth animation, so without this the audience has no visual confirmation
 * that the voice in the room belongs to the figure on screen. The bubble ties
 * them together.
 *
 * It also carries the room when the ASR or the PA is fighting a noisy hall —
 * a spectator at the back who cannot make out the audio can still follow the
 * game.
 *
 * Typed out rather than appearing whole, deliberately: the text arrives from the
 * LLM all at once, but the *speech* takes several seconds. A bubble that popped
 * fully formed would finish long before he stopped talking and read as a
 * subtitle running ahead of the audio. Typing paces it to roughly the speed of
 * speaking.
 *
 * Rendered with drei's `Html`, so it is real DOM projected into the 3D scene —
 * crisp at projector scale, where canvas text is not.
 */

/** Rough Hindi/Hinglish speaking pace, in ms per character. */
const MS_PER_CHAR = 42;

/** How long the finished bubble lingers before fading. */
const LINGER_MS = 2600;

export function SpeechBubble({
  text,
  position = [0, 1.62, -1.5],
}: {
  /** The latest thing the host said. Null hides the bubble. */
  text: string | null;
  position?: [number, number, number];
}) {
  const [shown, setShown] = useState("");
  const [visible, setVisible] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Clear any run still in flight — a new line must replace the old one
    // immediately, not queue behind it.
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];

    if (!text) {
      setVisible(false);
      return;
    }

    setShown("");
    setVisible(true);

    // One timeout per character rather than an interval, so the whole run can be
    // cancelled cleanly the moment he says something new.
    for (let i = 1; i <= text.length; i++) {
      timers.current.push(
        setTimeout(() => setShown(text.slice(0, i)), i * MS_PER_CHAR),
      );
    }
    timers.current.push(
      setTimeout(() => setVisible(false), text.length * MS_PER_CHAR + LINGER_MS),
    );

    return () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, [text]);

  if (!visible || !text) return null;

  const typing = shown.length < text.length;

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
          maxWidth: "22rem",
          minWidth: "8rem",
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

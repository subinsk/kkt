"use client";

import { useEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Scene, CAMERA_HOME } from "./scene";
import type { PublicGame } from "@/lib/game/state";
import type { HostLine } from "@/lib/use-host-line";

/**
 * The 3D viewport, shared by the projector and the host console.
 *
 * One component so the two can never drift. The operator needs to be looking at
 * *exactly* what the audience is looking at — if the console showed a slightly
 * different scene, every judgement made from it (did that wire cut land? is the
 * right seat lit?) would be made against the wrong picture.
 *
 * `interactive` adds drag-to-orbit, scroll-to-zoom, right-drag-to-pan. The
 * moment the user touches it, the automatic camera stops fighting them — see
 * the note on `userDriving` below.
 */
export function StageCanvas({
  game,
  agentLevelRef,
  minimal = false,
  interactive = false,
  /** Bump this to hand control back to the automatic camera. */
  resetToken = 0,
  hostLine = null,
  lineStatus = null,
  wordsPerSecond = null,
  onLineDone,
  frameloop,
  className,
}: {
  game: PublicGame;
  agentLevelRef: React.RefObject<number>;
  minimal?: boolean;
  interactive?: boolean;
  resetToken?: number;
  /** "demand" renders one frame and stops — for honouring reduced motion. */
  frameloop?: "always" | "demand";
  /** The host's current line, for the speech bubble. */
  hostLine?: HostLine | null;
  /**
   * The ledger's status for that line, when acks are flowing. Null means
   * nobody is reporting and the bubble should time itself off the audio.
   */
  lineStatus?: string | null;
  /** Measured speaking rate, for pacing the reveal. */
  wordsPerSecond?: number | null;
  /** Fired when that line is finished. See lib/use-host-line.ts. */
  onLineDone?: () => void;
  className?: string;
}) {
  /**
   * Who owns the camera right now.
   *
   * A plain ref rather than state, deliberately: it is read inside the render
   * loop every frame, and putting it in state would re-render the whole scene
   * on the first pixel of a drag.
   *
   * It lives out here, above the Canvas, so the reset button — which is DOM and
   * therefore outside the WebGL tree — can reach it.
   */
  const userDriving = useRef(false);

  useEffect(() => {
    if (resetToken > 0) userDriving.current = false;
  }, [resetToken]);

  return (
    <Canvas
      // Capped at 2. WebGL plus WebRTC plus screen-share on an unfamiliar
      // laptop is a real framerate risk, and a 3x retina buffer buys nothing
      // on a projector.
      // 1.5 in minimal mode: that flag exists for phones and for laptops
      // struggling to carry WebGL alongside WebRTC, and pixel count is the
      // cheapest thing to give up.
      dpr={minimal ? [1, 1.5] : [1, 2]}
      shadows={!minimal}
      gl={{ antialias: !minimal, powerPreference: "high-performance" }}
      camera={{ position: CAMERA_HOME, fov: 40 }}
      frameloop={frameloop}
      className={className}
    >
      <Scene
        game={game}
        agentLevelRef={agentLevelRef}
        minimal={minimal}
        interactive={interactive}
        userDriving={userDriving}
        hostLine={hostLine}
        lineStatus={lineStatus}
        wordsPerSecond={wordsPerSecond}
        onLineDone={onLineDone}
      />
    </Canvas>
  );
}

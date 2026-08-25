"use client";

import { useEffect, useRef, useState } from "react";
import { StageCanvas } from "@/components/stage/stage-canvas";
import {
  DEFAULT_DURATION_SECONDS,
  SEAT_COLORS,
  WIRE_COLORS,
  type PublicGame,
} from "@/lib/game/state";

/**
 * The landing hero: the actual set, in its actual lobby state.
 *
 * Not a stylised stand-in for the room — the room. `StageCanvas` is the same
 * component the projector runs, handed a lobby game with three seats filled, so
 * the front door is a literal preview of what pressing the button opens. Any
 * change to the set shows up here for free, and the two can never drift into
 * looking like different products.
 *
 * `minimal` because this is decoration on a page that phones load: no shadows,
 * lower pixel ratio. The set reads perfectly well without a shadow map, and
 * this is not the screen anyone is judging.
 */

/**
 * A lobby that never starts.
 *
 * Everything here is the resting state the projector shows before a game: full
 * clock, no wire in play, three connected contestants in Peer Talk — which is
 * also the default on a real phone, so the seats are correctly unlit and the
 * picture is honest about what it is showing.
 *
 * Built from `SEAT_COLORS` and `WIRE_COLORS` rather than hardcoded, so the
 * preview cannot show a different set of colours than the game uses.
 */
const DEMO_GAME: PublicGame = {
  code: "DEMO",
  phase: "lobby",
  secondsLeft: DEFAULT_DURATION_SECONDS,
  durationSeconds: DEFAULT_DURATION_SECONDS,
  paused: false,
  activeWire: null,
  deferred: [],
  wires: WIRE_COLORS.map((color) => ({
    color,
    status: "intact" as const,
    hintsGiven: 0,
    cutBy: null,
  })),
  players: ([0, 1, 2] as const).map((seat) => ({
    id: `demo-${seat}`,
    uid: 9000 + seat,
    name: ["Seat 1", "Seat 2", "Seat 3"][seat],
    seat,
    color: SEAT_COLORS[seat],
    connected: true,
    hasPhone: false,
    peerMode: true,
  })),
  live: [],
  hintsUsed: 0,
  wrongAnswers: 0,
  lifeline: {
    used: false,
    activeFor: null,
    status: "idle",
    requestedBy: null,
    granted: false,
    waiting: 0,
    limit: 0,
  },
  lastSpeaker: null,
  contested: false,
  /** Nobody has spoken on a landing page. */
  lastTurn: null,
  /**
   * Nobody is speaking, and nobody is reporting acks either.
   *
   * `degraded: true` is the honest value for a canvas with no room behind it —
   * there is no client subscribed to a transcript here — and it keeps the
   * landing page on the same code path a real projector uses when the ack
   * transport is down.
   */
  host: { current: null, degraded: true, wordsPerSecond: null },
  seq: 0,
};

export default function HeroCanvas() {
  const [still, setStill] = useState(false);

  /**
   * The host's mouth and key light are driven by his speaking level. Nothing is
   * speaking on the front door, so this stays at zero and he sits there idle —
   * waiting, which is exactly what the copy beside him claims.
   */
  const level = useRef(0);

  /**
   * Honour a reduced-motion preference by freezing the room rather than hiding
   * it. The picture is doing useful work — it says what the show is — and only
   * the movement is the thing being opted out of.
   */
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setStill(query.matches);
    const onChange = () => setStill(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return (
    <StageCanvas
      game={DEMO_GAME}
      agentLevelRef={level}
      minimal
      frameloop={still ? "demand" : "always"}
      className="h-full w-full"
    />
  );
}

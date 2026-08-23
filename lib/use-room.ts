"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicGame } from "./game/state";
import type { GameEvent } from "./game/state";

/**
 * Subscribe a screen to a room.
 *
 * Every surface uses this — phone, projector, host console — so they cannot
 * disagree about what is true. It holds the latest snapshot, applies ticks
 * locally, and hands recent events to the caller so the 3D scene can react to
 * `wire_cut` without polling for a diff.
 *
 * Reconnect resumes from the last sequence number seen rather than starting
 * over, which is what stops a dropped connection from replaying the wire-cut
 * animation for five wires at once.
 */

export type RoomEvent = GameEvent;

export function useRoom(code: string) {
  const [game, setGame] = useState<PublicGame | null>(null);
  const [connected, setConnected] = useState(false);
  /** Most recent first. Bounded — this is for reacting, not for history. */
  const [events, setEvents] = useState<RoomEvent[]>([]);

  const seqRef = useRef(0);
  const listeners = useRef(new Set<(event: RoomEvent) => void>());

  /** Register a side effect for a specific event type — used by the 3D scene. */
  const onEvent = useCallback((fn: (event: RoomEvent) => void) => {
    listeners.current.add(fn);
    // Wrapped so the cleanup returns void — Set.delete returns a boolean, and
    // React treats a returning cleanup as a misuse of useEffect.
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!code) return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    /** When the live feed last proved it was alive. */
    let lastTick = 0;

    const connect = () => {
      if (closed) return;
      source = new EventSource(
        `/api/room/${encodeURIComponent(code)}/events?since=${seqRef.current}`,
      );

      source.onopen = () => setConnected(true);

      source.addEventListener("snapshot", (e) => {
        lastTick = Date.now();
        const next = JSON.parse((e as MessageEvent).data) as PublicGame;
        seqRef.current = Math.max(seqRef.current, next.seq);
        setGame(next);
      });

      source.addEventListener("game", (e) => {
        lastTick = Date.now();
        const event = JSON.parse((e as MessageEvent).data) as RoomEvent;
        seqRef.current = Math.max(seqRef.current, event.seq);

        for (const fn of listeners.current) {
          try {
            fn(event);
          } catch {
            // One bad listener must not break the feed for the others.
          }
        }
        setEvents((prev) => [event, ...prev].slice(0, 40));

        // Anything that changes structure (not just the clock) is easiest to
        // absorb by re-reading state rather than patching it field by field.
        setGame((prev) =>
          prev ? { ...prev, seq: Math.max(prev.seq, event.seq) } : prev,
        );
        if (STRUCTURAL.has(event.type)) void refresh();
      });

      source.addEventListener("tick", (e) => {
        lastTick = Date.now();
        const t = JSON.parse((e as MessageEvent).data) as {
          secondsLeft: number;
          phase: PublicGame["phase"];
        };
        setGame((prev) =>
          prev
            ? { ...prev, secondsLeft: t.secondsLeft, phase: t.phase }
            : prev,
        );
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        // A tunnel hiccup should not need a page reload during a live round.
        if (!closed) retry = setTimeout(connect, 1200);
      };
    };

    const refresh = async () => {
      try {
        const res = await fetch(`/api/room/${encodeURIComponent(code)}`);
        if (res.ok) setGame(await res.json());
      } catch {
        // The stream will correct us on its next snapshot.
      }
    };

    /**
     * Polling fallback, and it is not belt-and-braces — it is what stops the UI
     * freezing.
     *
     * The clock on screen advances off the once-a-second `tick` event. If that
     * stream stalls the display simply stops at whatever second it last heard,
     * which reads as a hung app even though the server is fine. Serverless hosts
     * make this routine: the stream can land on an instance that does not hold
     * the room, and on Vercel Hobby it is severed every sixty seconds anyway.
     *
     * So: watch for ticks, and if none arrives for three seconds, start polling
     * state directly. The moment ticks resume, stop. SSE stays the fast path and
     * the clock can never sit still while the round is running.
     */
    const poll = setInterval(() => {
      if (Date.now() - lastTick < 3000) return;
      void refresh();
    }, 1000);

    void refresh();
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(poll);
      source?.close();
    };
  }, [code]);

  /** Fire an action and take the returned view as authoritative. */
  const act = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/room/${encodeURIComponent(code)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed");
      setGame(data as PublicGame);
      return data as PublicGame;
    },
    [code],
  );

  return { game, connected, events, onEvent, act };
}

/**
 * Events that change more than the clock, and so warrant a full re-read.
 *
 * Kept explicit rather than refreshing on everything: `level` and `tick` traffic
 * would otherwise trigger a fetch several times a second per screen.
 */
const STRUCTURAL = new Set([
  "player_joined",
  "player_rejoined",
  "player_presence",
  "peer_mode_changed",
  "peer_mode_all",
  "game_started",
  "wire_selected",
  "wire_cut",
  "wire_deferred",
  "hint_given",
  "wrong_answer",
  "penalty",
  "refund",
  "clock_paused",
  "clock_resumed",
  "lifeline_dialing",
  "lifeline_queued",
  "lifeline_connected",
  "lifeline_ended",
  "lifeline_failed",
  "game_over",
  "game_reset",
  "speaker_changed",
]);

/** mm:ss, the way a scoreboard shows it. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

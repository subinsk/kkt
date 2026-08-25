"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomEvent } from "./use-room";

/**
 * The host's lines, one at a time, in the order he says them.
 *
 * # Why this is a queue and not a variable
 *
 * All three surfaces used to keep the host's line in a single `useState` slot:
 * an event arrived, the slot was overwritten, the bubble showed whatever was
 * last written. Two things went wrong with that, and both were visible on stage.
 *
 * **Lines went missing.** Agora keeps its own outbound playback queue — its docs
 * are explicit that filler words and LLM responses "are played in the order they
 * arrive" — so two lines landing close together are both *spoken*, in sequence.
 * On our side the second overwrote the first before it had drawn a character, so
 * the room heard two sentences and the screen showed one. The audio side was
 * queued and the text side was not; this is the missing half.
 *
 * **Repeated lines showed nothing at all.** The old change detector compared
 * strings, and React bails out of a `setState` with an identical value, so
 * saying the same thing twice produced no change to notice and no re-reveal.
 * That is not a rare case: the system prompt explicitly instructs the host to
 * re-ask the question from the start after being interrupted, so the second ask
 * is *routinely* character-for-character identical to the first.
 *
 * The fix for both is identity. Every emitted event already carries a unique
 * monotonic `seq`, so the line is keyed by that rather than by its text — no new
 * server field was needed, the id was on the wire the whole time.
 *
 * # Who advances it
 *
 * The consumer does, by calling `lineDone()` when the bubble has finished with a
 * line. Not a timer: the bubble finishes when the *audio* stops, and only it
 * knows when that happened. The watchdog below is the exception, and exists only
 * because a consumer that unmounts mid-line would otherwise wedge the queue
 * shut for the rest of the round.
 */

export type HostLine = { id: number; text: string };

/**
 * Turn a server utterance id into the numeric id the bubble compares.
 *
 * The two sources of a line number them differently: the client queue keys off
 * the event `seq`, and the ledger issues `u1`, `u2`, `u3`. Both are monotonic
 * per room, and the bubble only ever asks "is this a different line than the one
 * I am revealing" — so stripping the prefix is enough, and it keeps the renderer
 * from having to know which source it is being fed by.
 *
 * Falls back to hashing anything unexpected rather than returning a constant,
 * because two different lines colliding on one id is the repeated-line bug
 * again: the second would never re-reveal.
 */
export function idOf(serverId: string): number {
  const n = Number(serverId.replace(/^u/, ""));
  if (Number.isFinite(n)) return n;
  let h = 0;
  for (let i = 0; i < serverId.length; i++) {
    h = (h * 31 + serverId.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Past this age, a line's audio has already been and gone.
 *
 * Reconnect replays everything missed since the last sequence number seen, which
 * is exactly right for a wire cut and exactly wrong for speech: subtitling four
 * sentences the room heard a minute ago is worse than subtitling none of them,
 * and on a riddle it hands over an answer nobody is still waiting for. Fifteen
 * seconds is comfortably longer than any single line takes to say.
 */
const STALE_MS = 15_000;

/**
 * How many lines may wait their turn.
 *
 * The staleness filter above catches the common burst, but a screen that
 * reconnects repeatedly can accumulate fresh-looking lines faster than they can
 * be spoken. Keeping the newest few and dropping the rest is the right bias: the
 * host has moved on, and so should the bubble.
 */
const MAX_QUEUED = 3;

/**
 * Longest a single line may hold the queue before it is forced along.
 *
 * A multiple of the line's own estimated duration rather than a flat number, for
 * the same reason the reveal is paced that way — a forty-word line legitimately
 * takes far longer than a three-word one. This should never fire in normal play;
 * it exists so that a consumer unmounting mid-line (the phone switching to its
 * end-of-round view, a projector dropping to minimal mode) cannot leave the
 * queue permanently blocked behind a line nobody is rendering any more.
 */
function maxHoldMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(8000, (words / 2.3) * 1000 * 3);
}

export function useHostLine(
  onEvent: (fn: (event: RoomEvent) => void) => () => void,
): { line: HostLine | null; lineDone: () => void } {
  const [line, setLine] = useState<HostLine | null>(null);

  const queue = useRef<HostLine[]>([]);
  /** Ids already queued, so a replayed event is not shown twice. */
  const seen = useRef(new Set<number>());
  const current = useRef<HostLine | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = () => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
  };

  /** Hand the next line to the renderer, if it is free to take one. */
  const pump = useCallback(() => {
    if (current.current) return;
    const next = queue.current.shift();
    if (!next) return;

    current.current = next;
    setLine(next);

    clearWatchdog();
    watchdog.current = setTimeout(() => {
      // Only ever advances past the line it was armed for.
      if (current.current?.id !== next.id) return;
      current.current = null;
      setLine(null);
      pump();
    }, maxHoldMs(next.text));
  }, []);

  const lineDone = useCallback(() => {
    clearWatchdog();
    current.current = null;
    setLine(null);
    pump();
  }, [pump]);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "host_said" && event.type !== "agent_spoke") return;
        if (seen.current.has(event.seq)) return;
        seen.current.add(event.seq);

        const text = String(event.payload.text ?? "").trim();
        if (!text) return;
        // Its audio is long gone. See STALE_MS.
        if (Date.now() - event.at > STALE_MS) return;

        queue.current.push({ id: event.seq, text });
        if (queue.current.length > MAX_QUEUED) {
          queue.current = queue.current.slice(-MAX_QUEUED);
        }
        pump();
      }),
    [onEvent, pump],
  );

  useEffect(() => clearWatchdog, []);

  return { line, lineDone };
}

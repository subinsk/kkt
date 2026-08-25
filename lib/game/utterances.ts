/**
 * What the host was asked to say, and what actually came out.
 *
 * # Why this exists
 *
 * The speech bubble used to render a *prediction*. `host_said` was emitted by the
 * LLM proxy the moment the model finished a turn — before the text had even been
 * handed to Agora, let alone spoken. Everything downstream of that point can
 * change what the room hears: Agora keeps its own outbound playback queue, it
 * inserts filler phrases we never see, `/speak` can preempt, barge-in truncates,
 * and TTS can simply fail. None of it reported back. So the screen showed one
 * thing and the speaker said another, and sentences went missing from whichever
 * side lost the race.
 *
 * This module is the other half: a record per utterance, moved only by
 * acknowledgements, with a deadline on every wait.
 *
 * # The shape is copied on purpose
 *
 * `status` + `since` + a per-status limit + a sweep called from the tick is
 * exactly how `LifelineState` and `sweepLifeline` already work, and that is the
 * one subsystem in this repo that has never silently hung. Reusing the shape
 * means the two read alike and neither needs its own vocabulary.
 *
 * There is no timer here. Deadlines are timestamps compared on read, for the
 * same reasons written above `secondsLeft()`: an interval drifts, dies on hot
 * reload, and double-counts if two ever race.
 */

import {
  REGISTERED_ORIGINS,
  TERMINAL_UTTERANCE_STATUSES,
  MAX_LEDGER_ITEMS,
  utteranceLimitMs,
  type Game,
  type Utterance,
  type UtteranceOrigin,
  type UtteranceStatus,
  type WireColor,
} from "./state";
import { emit } from "./store";

/* -------------------------------------------------------------------------- */
/* Registering                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Record a line we are about to have the host say.
 *
 * Called before the text reaches Agora, which is the only moment we hold it. The
 * returned id is what every later ack and every screen keys off — and it is a
 * real identity rather than the text, which is what kills the bug where the host
 * re-asking a question produced no visible change because the string had not
 * changed.
 */
export function registerUtterance(
  game: Game,
  origin: UtteranceOrigin,
  text: string,
  opts?: { retryOf?: string; attempts?: 1 | 2 },
): Utterance {
  const ledger = game.utterances;
  const u: Utterance = {
    id: `u${ledger.nextId++}`,
    origin,
    text: text.trim(),
    spoken: null,
    status: "pending",
    since: Date.now(),
    attempts: opts?.attempts ?? 1,
    retryOf: opts?.retryOf ?? null,
    turnId: null,
    speakingAt: null,
    wire: game.activeWire,
  };
  ledger.items.push(u);
  trim(ledger.items);
  emit(game, "utterance_pending", { id: u.id, origin, text: u.text });
  return u;
}

/**
 * Record a line we did not choose, on hearing it.
 *
 * Filler phrases and Agora's own `llm.failure_message` are spoken without ever
 * passing through our proxy, so there is nothing to register in advance. They
 * enter the ledger already `speaking`: no start deadline, never retried, because
 * there is no intended text to compare against and nothing was lost.
 *
 * Anything that matches neither a known filler nor the failure line is recorded
 * as `unattributed` and counted. That counter is the interesting one — it means
 * the host said something no part of our system chose.
 */
export function observeUtterance(
  game: Game,
  origin: Extract<UtteranceOrigin, "filler" | "failure" | "unattributed">,
  spoken: string,
  turnId: number | null,
): Utterance {
  const ledger = game.utterances;
  const u: Utterance = {
    id: `u${ledger.nextId++}`,
    origin,
    text: "",
    spoken,
    status: "speaking",
    since: Date.now(),
    attempts: 1,
    retryOf: null,
    turnId,
    speakingAt: Date.now(),
    wire: game.activeWire,
  };
  ledger.items.push(u);
  trim(ledger.items);
  if (origin === "unattributed") ledger.counts.unattributed++;
  emit(game, "utterance_observed", { id: u.id, origin, spoken });
  return u;
}

function trim(items: Utterance[]) {
  if (items.length > MAX_LEDGER_ITEMS) {
    items.splice(0, items.length - MAX_LEDGER_ITEMS);
  }
}

/* -------------------------------------------------------------------------- */
/* Acknowledging                                                              */
/* -------------------------------------------------------------------------- */

export type Ack = {
  /** Agora's turn id. The only handle a client has on an utterance. */
  turnId: number;
  status: "speaking" | "ended" | "interrupted";
  /** What the transcript says was said. */
  text: string;
  /** When the client observed it. */
  atMs: number;
};

/**
 * Apply one acknowledgement.
 *
 * Idempotent by `(turnId, status)`, and that is a design choice rather than
 * defensive coding: it means any number of clients may report the same stream
 * without electing a leader, so two open projector tabs are redundancy instead of
 * a race. Whichever gets there first wins and the rest are no-ops.
 *
 * Returns what happened, so the route can say so and the counters can move.
 */
export function applyAck(
  game: Game,
  ack: Ack,
): "applied" | "duplicate" | "late" | "unmatched" {
  const ledger = game.utterances;
  ledger.lastAckHeartbeat = Date.now();

  const existing = ledger.items.find((u) => u.turnId === ack.turnId);

  /* -- first sight of this turn ------------------------------------------- */
  if (!existing) {
    // A `speaking` ack we cannot match is either an utterance we registered but
    // could not tie to a turn yet, or something Agora said on its own.
    const claimed = claimOldestPending(ledger.items, ack);
    if (claimed) {
      advance(game, claimed, ack.status, ack.text);
      return "applied";
    }
    // Nothing was waiting. Classify it as best we can and count it.
    observeUtterance(game, classify(ack.text), ack.text, ack.turnId);
    return "applied";
  }

  if (existing.status === ack.status) return "duplicate";

  /**
   * A late ack is recorded and NOT applied.
   *
   * The watchdog has already given up on this line and the game has moved past
   * it — possibly by re-speaking it. Reviving it here would put a subtitle back
   * on screen for audio that finished long ago, and would let a stale line
   * outrank the one the host is actually saying. So it becomes a number in
   * /api/health rather than a state change.
   */
  if (TERMINAL_UTTERANCE_STATUSES.includes(existing.status)) {
    ledger.counts.lateAcks++;
    emit(game, "utterance_late_ack", {
      id: existing.id,
      was: existing.status,
      got: ack.status,
    });
    return "late";
  }

  advance(game, existing, ack.status, ack.text);
  return "applied";
}

/**
 * Tie an unmatched ack to the line most likely to have produced it.
 *
 * Agora's transcript gives us a `turn_id`; our own registration has no way to
 * know it in advance, so the two have to be joined on first contact. The oldest
 * thing still waiting to be spoken is the right guess, because Agora plays its
 * queue in arrival order — its docs say so explicitly — and so do we.
 *
 * Any status may claim, not just `speaking`. That restriction was wrong and it
 * cost a whole debugging cycle: in `TEXT` render mode Agora delivers a sentence
 * once, finished, with status END — the in-progress update never arrives at all.
 * So nothing could ever be claimed, every real line was recorded as a second,
 * `unattributed` record, and the line we had actually registered sat `pending`
 * until the watchdog abandoned it. The ledger reported a divergence it had
 * manufactured itself.
 */
function claimOldestPending(items: Utterance[], ack: Ack): Utterance | null {
  const waiting = items.filter(
    (u) =>
      u.turnId === null && (u.status === "pending" || u.status === "retrying"),
  );
  if (!waiting.length) return null;

  /**
   * Prefer the line whose words match, and only then the oldest.
   *
   * Arrival order alone is not enough, and the failure was intermittent — which
   * is worse than consistent. Once the LLM proxy is reachable there can be
   * several turns registered and unspoken at the same moment: a greeting still
   * playing, a silence prod behind it. Matching purely by "oldest waiting" then
   * pairs a transcript with whichever line happened to be registered first, and
   * a mismatch does real damage — the ledger invents an `unattributed` line, the
   * real one is left pending until the watchdog re-speaks it, and the bubble
   * shows a line the host is not saying.
   *
   * We hold both halves of the comparison, so use them. Falls back to the oldest
   * when the ack carries no text (a state-change ack) or nothing resembles it.
   */
  const t = norm(ack.text);
  if (t.length >= 6) {
    let best: Utterance | null = null;
    let bestScore = 0;
    for (const u of waiting) {
      const a = norm(u.text);
      if (a.length < 6) continue;
      const score =
        a === t || a.includes(t) || t.includes(a) ? 1 : similarity(a, t);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    // 0.5 rather than something stricter: TTS transcripts come back with
    // different punctuation and the odd mangled word, so an exact-ish match is
    // rare and a near match is the normal case.
    if (best && bestScore >= 0.5) {
      best.turnId = ack.turnId;
      return best;
    }
  }

  waiting[0].turnId = ack.turnId;
  return waiting[0];
}

/** Punctuation and case removed, whitespace collapsed. */
const norm = (v: string) =>
  v.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/**
 * Trigram overlap, 0..1.
 *
 * Deliberately duplicated from the echo filter rather than shared: that one is
 * about spotting the host's own voice coming back through a phone mic, this one
 * is about pairing a transcript with a registration, and coupling them would mean
 * a threshold tuned for one silently changing the other.
 */
function similarity(a: string, b: string): number {
  const grams = (v: string) => {
    const out = new Set<string>();
    for (let i = 0; i < v.length - 2; i++) out.add(v.slice(i, i + 3));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Which of Agora's own lines this was, if we can tell. */
function classify(spoken: string): "filler" | "failure" | "unattributed" {
  const t = spoken.trim();
  if (KNOWN_AGORA_LINES.filler.some((f) => t.startsWith(f.replace(/\.+$/, "")))) {
    return "filler";
  }
  if (KNOWN_AGORA_LINES.failure.some((f) => t.startsWith(f.slice(0, 12)))) {
    return "failure";
  }
  return "unattributed";
}

/**
 * The lines Agora speaks without asking us.
 *
 * Injected rather than imported so this module does not reach into the Agora
 * config, and set once at startup by `registerAgoraLines`. Prefix matching
 * because TTS transcripts come back without the trailing ellipsis.
 */
const KNOWN_AGORA_LINES: { filler: string[]; failure: string[] } = {
  filler: [],
  failure: [],
};

export function registerAgoraLines(filler: string[], failure: string[]) {
  KNOWN_AGORA_LINES.filler = filler;
  KNOWN_AGORA_LINES.failure = failure;
}

function advance(
  game: Game,
  u: Utterance,
  status: UtteranceStatus,
  spoken: string,
) {
  const now = Date.now();
  if (status === "speaking" && u.speakingAt === null) u.speakingAt = now;
  /**
   * Learn how fast he actually talks.
   *
   * A turn that started and finished gives a real duration for a known number of
   * words. That is the only calibration available — Sarvam sends no word timings
   * — and it removes the *systematic* half of the subtitle drift, which on a
   * long line is most of it.
   *
   * Guarded hard, because a bad rate is worse than the assumption it replaces: a
   * turn cut off by barge-in spent less time than its words needed, an observed
   * filler has no intended text to count, and a sub-second turn is noise. Only
   * clean, complete, long-enough turns teach anything.
   */
  if (status === "ended" && u.speakingAt !== null && u.text) {
    const words = u.text.trim().split(/\s+/).filter(Boolean).length;
    const seconds = (now - u.speakingAt) / 1000;
    if (words >= 4 && seconds >= 1) {
      const observed = words / seconds;
      // Sanity band. Outside this something else was going on — a stalled
      // stream, a clock jump — and the number is not about speech.
      if (observed > 0.5 && observed < 6) {
        const prev = game.utterances.wordsPerSecond;
        game.utterances.wordsPerSecond =
          prev === null ? observed : prev * 0.7 + observed * 0.3;
      }
    }
  }
  u.status = status;
  u.since = now;
  if (spoken.trim()) u.spoken = spoken.trim();
  emit(game, `utterance_${status}`, {
    id: u.id,
    origin: u.origin,
    text: u.text,
    spoken: u.spoken,
  });
}

/* -------------------------------------------------------------------------- */
/* The watchdog                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether it is safe to re-speak right now.
 *
 * Not while somebody is talking. Barge-in fires on 160ms of speech, so
 * re-speaking into a room that is mid-answer would very likely be cut off
 * immediately — spending the single retry to achieve nothing. There is no user
 * turn ledger yet (that is the next step), so for now the floor counts as busy
 * only when someone is actually published to the host.
 */
function floorIsQuiet(game: Game): boolean {
  return game.players.every((p) => p.peerMode || !p.connected);
}

/** A retry that no longer makes sense. */
function isStale(game: Game, u: Utterance): boolean {
  if (game.phase !== "running") return true;
  // A line about a wire that has since moved on. Re-asking a cut wire's riddle
  // is worse than saying nothing at all.
  return u.wire !== null && u.wire !== game.activeWire;
}

/**
 * Called from every mutation and from the SSE tick, exactly like
 * `sweepLifeline`. There is no authoritative timer — see the note on
 * `secondsLeft`.
 *
 * `respeak` is injected so this stays a pure state machine that the checks can
 * drive without a network. In the app it is the `/speak` call.
 */
export function sweepUtterances(
  game: Game,
  respeak?: (text: string) => void,
  now = Date.now(),
) {
  const ledger = game.utterances;

  for (const u of ledger.items) {
    const limit = utteranceLimitMs(u);
    if (limit === 0) continue;
    if (now - u.since < limit) continue;

    /**
     * He started, so the room heard him; only the END ack went missing.
     *
     * This is the one deadline that fails OPEN, and deliberately so. Re-speaking
     * here would duplicate audio the room demonstrably received, which is worse
     * than closing a line a beat late.
     */
    if (u.status === "speaking") {
      u.status = "ended";
      u.since = now;
      emit(game, "utterance_ended", {
        id: u.id,
        origin: u.origin,
        text: u.text,
        spoken: u.spoken,
        assumed: true,
      });
      continue;
    }

    /* -- nothing was ever heard ------------------------------------------ */

    // Not ours to re-speak. Nothing was lost that we could put back.
    if (!REGISTERED_ORIGINS.includes(u.origin)) {
      abandon(game, u, "not ours to retry", now);
      continue;
    }
    if (isStale(game, u)) {
      abandon(game, u, "stale", now);
      continue;
    }
    if (u.attempts >= 2) {
      abandon(game, u, "retried once already", now);
      continue;
    }
    // Wait for a gap rather than burning the one retry into a busy room. The
    // deadline is re-evaluated on the next sweep, so this is a hold, not a drop.
    if (!floorIsQuiet(game)) continue;

    u.status = "lost";
    u.since = now;
    emit(game, "utterance_lost", { id: u.id, origin: u.origin, text: u.text });

    const retry = registerUtterance(game, u.origin, u.text, {
      retryOf: u.id,
      attempts: 2,
    });
    retry.status = "retrying";
    retry.since = now;
    respeak?.(u.text);
    emit(game, "utterance_retrying", {
      id: retry.id,
      retryOf: u.id,
      text: u.text,
    });
  }
}

function abandon(game: Game, u: Utterance, reason: string, now: number) {
  u.status = "abandoned";
  u.since = now;
  game.utterances.counts.abandoned++;
  emit(game, "utterance_abandoned", {
    id: u.id,
    origin: u.origin,
    text: u.text,
    reason,
  });
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Lines we meant to say that the room never got, and lines the room got that we
 * never chose. The two directions of the same divergence, for /api/health.
 */
export function divergences(game: Game) {
  const ledger = game.utterances;
  return {
    abandoned: ledger.counts.abandoned,
    unattributed: ledger.counts.unattributed,
    lateAcks: ledger.counts.lateAcks,
    /** Still waiting, right now. A standing number here means acks are broken. */
    pending: ledger.items.filter(
      (u) => u.status === "pending" || u.status === "retrying",
    ).length,
  };
}

/** For the check script: find one by id without exporting the whole ledger. */
export function findUtterance(game: Game, id: string): Utterance | undefined {
  return game.utterances.items.find((u) => u.id === id);
}

export type { Utterance, UtteranceOrigin, UtteranceStatus, WireColor };

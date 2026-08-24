/**
 * The game's data model.
 *
 * Everything here is authoritative and lives on the server. The LLM is *told*
 * this state on every turn and is never allowed to compute any of it — spec §7.
 * A language model asked to count seconds will invent a number, confidently,
 * in front of judges.
 */

export const WIRE_COLORS = ["red", "blue", "yellow", "green", "white"] as const;
export type WireColor = (typeof WIRE_COLORS)[number];

/**
 * For the phone UI and the projected chyron. Read, never spoken.
 *
 * English, because every screen in this project is: the host talks Hinglish,
 * the interface does not. `WIRE_LABELS_DEV` below is the spoken map, and the two
 * are deliberately separate — see the note on it.
 */
export const WIRE_LABELS_EN: Record<WireColor, string> = {
  red: "red",
  blue: "blue",
  yellow: "yellow",
  green: "green",
  white: "white",
};

/**
 * Devanagari, for anything that goes to TTS.
 *
 * Sarvam Bulbul is a Hindi voice reading `target_language_code: hi-IN`. Handed
 * Roman text it reads it as English — "laal taar" comes out as a tourist
 * reading a phrasebook. So spoken strings and displayed strings are two
 * different maps, and mixing them up is a bug you can only hear.
 */
export const WIRE_LABELS_DEV: Record<WireColor, string> = {
  red: "लाल",
  blue: "नीला",
  yellow: "पीला",
  green: "हरा",
  white: "सफ़ेद",
};

export type WireStatus = "intact" | "cut" | "deferred";

export type Wire = {
  color: WireColor;
  status: WireStatus;
  /** Which riddle was drawn for this wire this round. */
  riddleId: string;
  hintsGiven: number;
  cutBy: string | null;
  cutAt: number | null;
};

export type Player = {
  /** Stable across reconnects; what the LLM and the 3D scene key off. */
  id: string;
  /** Agora RTC uid. Numeric because agora-token mints per-uid tokens. */
  uid: number;
  name: string;
  seat: 0 | 1 | 2 | 3;
  /**
   * Consent-gated and session-only — spec §9.6. Never persisted, never logged,
   * dropped by `endGame`. Only ever leaves the server as a Vobiz `to` field.
   */
  phoneE164: string | null;
  consent: boolean;
  connected: boolean;
  joinedAt: number;
  /**
   * Peer Talk. True means this contestant is talking to the *other contestants*
   * and the host cannot hear them — their mic is not published to the channel.
   *
   * This is the default, and it is the single biggest simplification in the
   * project. Because only a contestant who has explicitly gone live is audible
   * to the agent, "who said that?" usually has exactly one answer, and the
   * three-open-mics-in-one-room echo problem mostly stops existing. Discussion
   * happens through air, which is what people do anyway.
   */
  peerMode: boolean;
};

export type GamePhase = "lobby" | "running" | "won" | "lost";

export type WrongAnswer = {
  playerId: string;
  playerName: string;
  wire: WireColor | null;
  text: string;
  at: number;
};

export type LifelineState = {
  used: boolean;
  /** Set while a call is live so the UI can show the ring and mute the handset. */
  activeFor: string | null;
  callId: string | null;
  status: "idle" | "dialing" | "ringing" | "connected" | "done" | "failed";
  /** Charged on `answered`, refunded on failure — spec §9.4. */
  penaltyApplied: boolean;
  /**
   * The host has said yes. The button unlocks; the call is still not placed.
   *
   * Three states, not two, because the interesting one is the middle: asked but
   * not yet allowed. A button that dials on first press would let one careless
   * thumb spend forty-five seconds of a six-minute round, and a button that is
   * simply always live makes the host's permission decorative. So: locked →
   * granted by the host → the contestant presses it themselves.
   */
  granted: boolean;
  /**
   * When the status last changed.
   *
   * Exists so nothing can wait forever. Vobiz webhooks are the only thing that
   * moves a call from dialing to connected to done, and a webhook that never
   * arrives — a lost request, a stale tunnel, a carrier that simply goes quiet —
   * would otherwise leave the call pinned open. Since the host is muted for the
   * duration of a call, that is not a stuck ring indicator: it is a host who
   * never speaks again.
   */
  since: number;
  /**
   * A contestant has tapped the button but the call has NOT been placed.
   *
   * The tap is a request, not a trigger. It goes into LIVE STATE, the host asks
   * "chalis-paanch second lagenge, pakka?", and only a spoken yes causes the
   * dial. That confirmation-before-irreversible-action beat is one of the main
   * things the quiz-show frame buys us (spec §1), so the button must not
   * shortcut it.
   */
  requestedBy: string | null;
};

export type GameEvent = {
  seq: number;
  at: number;
  type: string;
  payload: Record<string, unknown>;
};

export type Game = {
  code: string;
  /** When the room was opened. Drives expiry — see `ROOM_TTL_MS`. */
  createdAt: number;
  phase: GamePhase;
  players: Player[];
  wires: Wire[];
  activeWire: WireColor | null;
  /** Wires the players parked for later. The host is expected to come back. */
  deferred: WireColor[];

  durationSeconds: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Host console pause. While set, the clock does not advance. */
  pausedAt: number | null;
  pausedTotalMs: number;
  /** Sum of every penalty and refund. Positive burns clock. */
  penaltySeconds: number;

  hintsUsed: number;
  lifeline: LifelineState;
  wrongAnswers: WrongAnswer[];

  /** Last attributed speaker, for addressing people by name. */
  lastSpeaker: string | null;
  contested: boolean;

  events: GameEvent[];
  seq: number;
};

/**
 * How long each lifeline state may last before the watchdog intervenes.
 *
 * Thirty seconds to answer: an Indian mobile rings for three to eight, so thirty
 * is generous and still short enough that a dead call does not eat an eighth of
 * the round. Ninety on a live call, comfortably past the forty-five second
 * window plus the sign-off, so the watchdog only ever fires when a hangup
 * webhook was genuinely lost.
 */
export function lifelineLimit(status: LifelineState["status"]): number {
  if (status === "dialing" || status === "ringing") return 30;
  if (status === "connected") return 90;
  return 0;
}

export const DEFAULT_DURATION_SECONDS = 360; // 6:00, spec §5

/**
 * How long a room lives before it is dropped, measured from when it was opened.
 *
 * Rooms are in-memory and codes are minted per show, so without this a process
 * that stays up across a demo day accumulates every abandoned room anyone
 * created — each holding its own event log and subscriber set.
 *
 * Evaluated on lookup, never on a timer. `secondsLeft()` derives the clock from
 * timestamps for the reasons written above it, and the same argument applies
 * here: a `setInterval` sweeper dies on hot reload and double-fires if two ever
 * race. An expired room is one nobody has asked for yet, which is exactly when
 * there is a lookup to hang the check off.
 */
export const ROOM_TTL_MS = 60 * 60 * 1000; // 1 hour
export const PENALTY_WRONG = 20;
export const PENALTY_HINT = 15;
export const PENALTY_LIFELINE = 45;

/** Seat colours, shared by the phone UI and the 3D contestant lights. */
export const SEAT_COLORS = ["#ff6b4a", "#4ac8ff", "#ffd24a", "#7dff9e"] as const;

/**
 * The clock, derived rather than ticked.
 *
 * There is no `setInterval` decrementing a counter anywhere in this project. A
 * ticking integer drifts, dies on hot reload, and double-counts if two timers
 * ever race. Deriving from timestamps means every reader — phones, projector,
 * LLM, host console — computes the same number from the same facts.
 */
export function secondsLeft(game: Game): number {
  if (game.phase === "lobby" || game.startedAt === null) {
    return game.durationSeconds;
  }
  const now = game.endedAt ?? Date.now();
  const paused =
    game.pausedTotalMs + (game.pausedAt !== null ? now - game.pausedAt : 0);
  const elapsed = (now - game.startedAt - paused) / 1000;
  const left = game.durationSeconds - elapsed - game.penaltySeconds;
  return Math.max(0, Math.round(left));
}

export function wiresBy(game: Game, status: WireStatus): WireColor[] {
  return game.wires.filter((w) => w.status === status).map((w) => w.color);
}

export function findWire(game: Game, color: WireColor): Wire | undefined {
  return game.wires.find((w) => w.color === color);
}

export function findPlayer(game: Game, id: string): Player | undefined {
  return game.players.find((p) => p.id === id);
}

export function playerByUid(game: Game, uid: number): Player | undefined {
  return game.players.find((p) => p.uid === uid);
}

/**
 * Contestants the host can currently hear — Peer Talk off.
 *
 * When this returns exactly one player, attribution is solved: whatever the ASR
 * heard, that is who said it. When it returns none, the host should be told the
 * room is in discussion rather than left wondering why it went quiet.
 */
export function livePlayers(game: Game): Player[] {
  return game.players.filter((p) => !p.peerMode && p.connected);
}

export function peerTalkPlayers(game: Game): Player[] {
  return game.players.filter((p) => p.peerMode && p.connected);
}

/** True once every wire is cut. Deferred wires still count as uncut. */
export function allWiresCut(game: Game): boolean {
  return game.wires.every((w) => w.status === "cut");
}

/**
 * The public shape sent to phones, the projector and the host console.
 * Phone numbers are stripped — they never leave the server.
 */
export function publicView(game: Game) {
  return {
    code: game.code,
    phase: game.phase,
    secondsLeft: secondsLeft(game),
    durationSeconds: game.durationSeconds,
    paused: game.pausedAt !== null,
    activeWire: game.activeWire,
    deferred: game.deferred,
    wires: game.wires.map((w) => ({
      color: w.color,
      status: w.status,
      hintsGiven: w.hintsGiven,
      cutBy: w.cutBy,
    })),
    players: game.players.map((p) => ({
      id: p.id,
      uid: p.uid,
      name: p.name,
      seat: p.seat,
      color: SEAT_COLORS[p.seat],
      connected: p.connected,
      hasPhone: p.phoneE164 !== null,
      peerMode: p.peerMode,
    })),
    /** Who the host can hear right now. Drives the chyron and the 3D seats. */
    live: livePlayers(game).map((p) => p.id),
    hintsUsed: game.hintsUsed,
    wrongAnswers: game.wrongAnswers.length,
    lifeline: {
      used: game.lifeline.used,
      activeFor: game.lifeline.activeFor,
      status: game.lifeline.status,
      requestedBy: game.lifeline.requestedBy,
      granted: game.lifeline.granted,
      /** Seconds spent in the current state, for the on-screen countdown. */
      waiting: Math.max(0, Math.round((Date.now() - game.lifeline.since) / 1000)),
      /** How long this state is allowed to last before the watchdog acts. */
      limit: lifelineLimit(game.lifeline.status),
    },
    lastSpeaker: game.lastSpeaker,
    contested: game.contested,
    seq: game.seq,
  };
}

export type PublicGame = ReturnType<typeof publicView>;

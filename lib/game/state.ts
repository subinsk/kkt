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

/* -------------------------------------------------------------------------- */
/* The utterance ledger                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where a spoken line came from, which decides what we are allowed to do if it
 * goes missing.
 *
 * The split that matters is registered versus observed. We hold the text of a
 * `greeting`, a `turn` or a `scripted` line *before* it is spoken, so those can
 * be waited for and re-spoken. A `filler` is chosen by Agora and never passes
 * through our proxy, so there is nothing to wait for and nothing to retry — it
 * can only ever be noticed after the fact.
 */
export type UtteranceOrigin =
  | "greeting"
  | "turn"
  | "scripted"
  | "filler"
  | "failure"
  /** Heard, and nothing on our side chose it. Always a bug worth counting. */
  | "unattributed";

/** Origins we hold the text for in advance, and may therefore retry. */
export const REGISTERED_ORIGINS: UtteranceOrigin[] = [
  "greeting",
  "turn",
  "scripted",
  "failure",
];

export type UtteranceStatus =
  /** We have the text. Nothing has been heard yet. */
  | "pending"
  /** Acked: TTS started for this turn. */
  | "speaking"
  /** Acked: the turn ended normally. */
  | "ended"
  /** Acked: barge-in. `spoken` holds only what reached the room. */
  | "interrupted"
  /** The start deadline passed with no ack. */
  | "lost"
  /** Re-spoken once. Linked to the original by `retryOf`. */
  | "retrying"
  /** Retried and still not heard. The game moves on. */
  | "abandoned";

/**
 * Statuses nothing may move out of. See `applyAck` for why this is enforced.
 *
 * `lost` belongs here, which is easy to get wrong: it reads like a waiting state
 * but it is not. The moment a line is declared lost, a *separate* record is
 * created for the retry — so the original is finished with, permanently, and an
 * ack that turns up for it afterwards must be counted as late rather than
 * applied. Leaving it off this list let a stale line come back to life and
 * outrank the one the host was actually saying.
 */
export const TERMINAL_UTTERANCE_STATUSES: UtteranceStatus[] = [
  "ended",
  "interrupted",
  "abandoned",
  "lost",
];

export type Utterance = {
  id: string;
  origin: UtteranceOrigin;
  /** What we meant to say. Empty for an observed utterance until it is heard. */
  text: string;
  /**
   * What the transcript says actually came out.
   *
   * Kept apart from `text` because the two together are the divergence check,
   * and because for an interrupted line only this half reached the room — which
   * is also the half the echo filter must match against.
   */
  spoken: string | null;
  status: UtteranceStatus;
  /** When the status last changed. Same field, same meaning as on the lifeline. */
  since: number;
  attempts: 1 | 2;
  retryOf: string | null;
  /** Agora's `turn_id`, once an ack tells us which turn this became. */
  turnId: number | null;
  /**
   * When this line was acked as `speaking`.
   *
   * Kept alongside `since` rather than derived from it, because `since` moves on
   * every transition. Together with the moment the turn ends, this is a measured
   * duration for a known number of words — which is the only way to learn how
   * fast this voice actually talks.
   */
  speakingAt: number | null;
  /**
   * The wire this line was about.
   *
   * Only so a retry can be refused once it is stale: re-asking a riddle for a
   * wire that has since been cut is worse than saying nothing.
   */
  wire: WireColor | null;
};

/**
 * How long an utterance may sit in its current status before the watchdog acts,
 * in **milliseconds**.
 *
 * Note the unit, and note that `lifelineLimit()` next door returns *seconds*.
 * Speech is timed in hundreds of milliseconds and phone calls in tens of
 * seconds; the `Ms` suffix is the only thing standing between those two, so it
 * is mandatory on every constant in this family.
 *
 * Zero means "nothing is being waited for" — a terminal status, or an observed
 * utterance that was already speaking when we first heard about it.
 */
export function utteranceLimitMs(u: Utterance): number {
  if (u.status === "pending" || u.status === "retrying") {
    return startDeadlineMs(u.origin);
  }
  if (u.status === "speaking") return spokenEstimateMs(u.text) * END_SLACK;
  return 0;
}

/**
 * How long to wait for TTS to start, by origin.
 *
 * Constant-ish rather than proportional, because this is time-to-first-byte and
 * does not depend on how long the line is. It does depend on whether the
 * pipeline is warm:
 *
 * The greeting is published the instant Agora accepts the `/join`, and the agent
 * still has to connect to the channel and Sarvam still has to return its first
 * audio. Seconds, on a cold start — which is exactly the reasoning that set
 * `ONSET_TIMEOUT_MS` in lib/subtitles.ts, and these two should be read together.
 * Mid-round, everything is already up.
 *
 * Both are seeds. Agora reports real per-module TTS latency through
 * `AGENT_METRICS` (we already ask for it with `enable_metrics: true`), so the
 * intended end state is that these become measured rather than estimated.
 */
export function startDeadlineMs(origin: UtteranceOrigin): number {
  return origin === "greeting" ? 6000 : 2500;
}

/**
 * How much longer than the estimate a line may take before we assume the END ack
 * was lost.
 *
 * `spokenEstimateMs` is already biased slow on purpose. 1.6 on top keeps a long
 * line from being declared over while he is audibly still saying it — the
 * failure that would matter, since this deadline resolves *fail open*.
 */
export const END_SLACK = 1.6;

/**
 * Estimated time to say a line, in milliseconds.
 *
 * Deliberately duplicated from `spokenDurationMs` in lib/subtitles.ts rather
 * than imported: that module is client-side subtitle machinery and this is
 * server-side game state, and a server importing the renderer to time a
 * watchdog is a dependency worth not having. The rate is the same figure for the
 * same reason — words per second, not characters, because Devanagari spends two
 * or three code points on a syllable that Latin spends one on.
 */
function spokenEstimateMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (Math.max(1, words) / 2.3) * 1000;
}

/**
 * Utterance state for one room.
 *
 * `degraded` is the safety valve on a fail-closed design. With no client
 * reporting acks, nothing would ever reach `speaking`, and a renderer that draws
 * only acked lines would draw nothing at all for the rest of the round. So the
 * ledger tracks whether anybody is listening, and when nobody is, the screens
 * fall back to the estimate — the behaviour that shipped before any of this
 * existed. Fail closed is right when acks work; a silent blackout never is.
 *
 * A room therefore *starts* degraded, which is correct rather than a cold-start
 * bug: the greeting is published before any client could possibly have
 * subscribed.
 */
export type UtteranceLedger = {
  items: Utterance[];
  /** When a reporter last checked in. Null until one ever has. */
  lastAckHeartbeat: number | null;
  /** Counters for /api/health. Monotonic across the round. */
  counts: { abandoned: number; unattributed: number; lateAcks: number };
  /**
   * How fast the host actually speaks, in words per second, measured.
   *
   * `SPOKEN_WORDS_PER_SECOND = 2.3` in lib/subtitles.ts is an assumption, and a
   * subtitle reveal paced by an assumption drifts for the whole length of a line.
   * On a paragraph-long greeting — forty seconds of audio — a rate that is 30%
   * out means the text finishes twelve seconds before the voice does, which is
   * what "the subtitle is completely different from the audio" actually looks
   * like.
   *
   * Sarvam supplies no word timings (measured, see docs/AGORA-NOTES.md), so the
   * interior of a line cannot be made exact. But the *rate* can be learned: each
   * completed turn gives a real duration for a known word count. Smoothed,
   * because one short turn is noisy, and left null until there is real data
   * rather than seeded with the guess it is replacing.
   */
  wordsPerSecond: number | null;
  /**
   * Why the last reporter could not start, if it said.
   *
   * Without this, a reporter that fails to log in is indistinguishable from one
   * that was never opened: both leave the room degraded and the screens quietly
   * fall back to the estimate. That is the right *behaviour* and a terrible
   * diagnostic — "Signaling is not enabled for this App ID" and "nobody opened
   * the projector" need entirely different fixes.
   *
   * Deliberately does NOT count as a heartbeat. A reporter that is alive but
   * broken must leave the room degraded, or the screens would trust acks that
   * are never coming.
   */
  reporterError: string | null;
  nextId: number;
};

/** No heartbeat for this long and the screens stop trusting the acks. */
export const DEGRADE_AFTER_MS = 6000;

/* -------------------------------------------------------------------------- */
/* The other side of the conversation                                         */
/* -------------------------------------------------------------------------- */

/**
 * One thing a contestant said, and who we think said it.
 *
 * The mirror of `Utterance`, and it exists for the same reason: without a record
 * of a human turn having a beginning and an end, `attribute()` cannot be called
 * at all — which is exactly why it never was, and why `contested` has been
 * permanently false while three phones streamed mic levels into a store nothing
 * read.
 *
 * `contested` is a first-class outcome rather than a failure. Two people talking
 * over each other is the case judges will deliberately create, and the honest
 * answer is to tell the host it happened so he serialises the floor by name.
 */
export type UserTurn = {
  id: string;
  /** What the host was given, after the echo was subtracted. */
  text: string;
  /** What arrived before that subtraction, when the two differ. */
  raw: string | null;
  status: "final" | "echo";
  at: number;
  playerId: string | null;
  playerName: string | null;
  contested: boolean;
  confidence: number;
  /**
   * How confident we are allowed to be. "live" and "hold" are facts; "level"
   * is a measurement; "none" means nobody was named. `uid` is unreachable — see
   * docs/AGORA-NOTES.md, 24 Aug 2026: human transcripts arrive as uid 0.
   */
  source: "live" | "hold" | "level" | "uid" | "none";
};

/** Keep the last few for the host console and /api/health. Not a history. */
export const MAX_USER_TURNS = 12;

/** True when nobody is reporting acks and the renderer must estimate instead. */
export function isDegraded(ledger: UtteranceLedger, now = Date.now()): boolean {
  return (
    ledger.lastAckHeartbeat === null ||
    now - ledger.lastAckHeartbeat > DEGRADE_AFTER_MS
  );
}

/**
 * How many utterances to keep.
 *
 * Only the current one is rendered; the rest are kept so a late ack has
 * something to land on and so the divergence counters have a window to look at.
 * A six-minute round is maybe fifty lines, so this holds the lot.
 */
export const MAX_LEDGER_ITEMS = 60;

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
  /** Everything the host has been asked to say, and what became of it. */
  utterances: UtteranceLedger;
  /** And the other direction: what the room said, and who said it. */
  userTurns: UserTurn[];
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

/**
 * Wires that still have to be cut before the round can be won.
 *
 * Deliberately "not cut" rather than "intact", and that distinction is the whole
 * point of this function existing. A **deferred** wire is parked, not finished —
 * it still has to be come back to. LIVE STATE used to report only `intact` and
 * `cut`, so a board with four cut and one parked read as "Intact wires: none",
 * and the host concluded the team had won while the clock was still running and
 * the panel still showed the fifth wire.
 *
 * That is precisely the thing AGENTS.md forbids: the model deriving state
 * instead of being told it. So the count is computed here, once, and every
 * surface — the state block, every tool result — is handed the answer.
 */
export function wiresRemaining(game: Game): WireColor[] {
  return game.wires.filter((w) => w.status !== "cut").map((w) => w.color);
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
    /**
     * How the last attribution was actually decided.
     *
     * On screen this is what lets the host console show "Rahul (contested)"
     * rather than a bare name it cannot justify — and during a rehearsal it is
     * the only way to tell a confident attribution from a coin-flip between two
     * people who spoke at once.
     */
    lastTurn: game.userTurns.length
      ? {
          text: game.userTurns[game.userTurns.length - 1].text,
          playerName: game.userTurns[game.userTurns.length - 1].playerName,
          contested: game.userTurns[game.userTurns.length - 1].contested,
          confidence: game.userTurns[game.userTurns.length - 1].confidence,
          source: game.userTurns[game.userTurns.length - 1].source,
        }
      : null,
    /**
     * The line the host is on, as the acks understand it.
     *
     * Only the one — the screens render a bubble, not a transcript, and shipping
     * the whole ledger down every snapshot would put a growing array on the wire
     * once a second for no reader. `degraded` travels with it because the
     * renderer needs to know whether to trust `status` or fall back to timing
     * the line off the audio level.
     */
    host: {
      current: currentUtterance(game.utterances),
      degraded: isDegraded(game.utterances),
      /**
       * The measured speaking rate, for the subtitle reveal to pace itself by.
       * Null until a turn has completed, in which case the renderer keeps its
       * own default.
       */
      wordsPerSecond: game.utterances.wordsPerSecond,
    },
    seq: game.seq,
  };
}

/**
 * The utterance the screens should be showing.
 *
 * The most recent one that is not finished with. Deliberately not "the last item"
 * — a `speaking` line that is then followed into the ledger by a `pending` one
 * must keep the bubble until it actually ends, or the room hears the end of a
 * sentence whose subtitle has already moved on.
 */
export function currentUtterance(ledger: UtteranceLedger): {
  id: string;
  text: string;
  status: UtteranceStatus;
  spoken: string | null;
} | null {
  const shape = (u: Utterance) => ({
    id: u.id,
    text: u.text || (u.spoken ?? ""),
    status: u.status,
    spoken: u.spoken,
  });
  const renderable = (u: Utterance) =>
    u.status !== "abandoned" && u.status !== "lost" && (!!u.text || !!u.spoken);

  /**
   * A line being spoken outranks anything queued behind it.
   *
   * This is not a tie-break, it is the whole rule. Registration happens before
   * TTS, so the next line routinely enters the ledger while the host is still
   * mid-sentence on the current one — and "newest wins" would move the subtitle
   * on while the room was still hearing the end of the previous sentence. That
   * is the original bug in a new place.
   */
  for (let i = ledger.items.length - 1; i >= 0; i--) {
    if (ledger.items[i].status === "speaking") return shape(ledger.items[i]);
  }
  for (let i = ledger.items.length - 1; i >= 0; i--) {
    if (renderable(ledger.items[i])) return shape(ledger.items[i]);
  }
  return null;
}

export type PublicGame = ReturnType<typeof publicView>;

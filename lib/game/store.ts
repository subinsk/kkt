/**
 * The authoritative game store.
 *
 * Every rule in spec §5 is enforced here and nowhere else. The LLM proposes;
 * this file decides. That split is what makes the game honest: a model that
 * hallucinates "you cut the blue wire" changes nothing, because the wire is
 * only cut when `cutWire` says so.
 *
 * In-memory on purpose. The demo needs a judge to see a change land within
 * milliseconds, and a round lives for six minutes. Swap for Redis if this
 * outlives the event.
 */

import {
  DEFAULT_DURATION_SECONDS,
  PENALTY_HINT,
  PENALTY_LIFELINE,
  PENALTY_WRONG,
  WIRE_COLORS,
  allWiresCut,
  findPlayer,
  findWire,
  lifelineLimit,
  livePlayers,
  publicView,
  secondsLeft,
  type Game,
  type GameEvent,
  type Player,
  type WireColor,
} from "./state";
import { getRiddle, riddleForWire } from "./riddles";
import { LIFELINE_LINES, hostSay } from "./host-speak";

type Subscriber = (event: GameEvent) => void;

type Store = {
  games: Map<string, Game>;
  subscribers: Map<string, Set<Subscriber>>;
};

// Survives hot reload — a fresh module per reload would drop a live round.
const globalStore = globalThis as unknown as { __kktStore?: Store };
const store: Store = (globalStore.__kktStore ??= {
  games: new Map(),
  subscribers: new Map(),
});

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Append to the log and fan out to every connected client.
 *
 * `seq` is monotonic per game so a client that reconnects can ask for
 * everything after the last sequence number it saw, instead of re-syncing blind.
 */
export function emit(
  game: Game,
  type: string,
  payload: Record<string, unknown> = {},
): GameEvent {
  game.seq += 1;
  const event: GameEvent = { seq: game.seq, at: Date.now(), type, payload };

  game.events.push(event);
  // The log is for reconnect catch-up and the post-game summary, not history.
  if (game.events.length > 400) game.events.splice(0, game.events.length - 400);

  for (const fn of store.subscribers.get(game.code) ?? []) {
    try {
      fn(event);
    } catch {
      // A dead SSE writer must never take down a game mutation.
    }
  }
  return event;
}

export function subscribe(code: string, fn: Subscriber): () => void {
  const set = store.subscribers.get(code) ?? new Set<Subscriber>();
  set.add(fn);
  store.subscribers.set(code, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) store.subscribers.delete(code);
  };
}

export function eventsSince(game: Game, seq: number): GameEvent[] {
  return game.events.filter((e) => e.seq > seq);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/** Room codes are read aloud and typed on phones: no 0/O/1/I/5/S ambiguity. */
const CODE_ALPHABET = "ACDEFHJKMNPRTVWXY2346789";

export function newRoomCode(length = 4): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return store.games.has(code) ? newRoomCode(length) : code;
}

export function createGame(opts?: {
  code?: string;
  durationSeconds?: number;
}): Game {
  const code = opts?.code?.toUpperCase() ?? newRoomCode();

  const game: Game = {
    code,
    phase: "lobby",
    players: [],
    // Riddles are bound to colours, not to a sequence — that is what lets a
    // contestant say "blue wale ka batao" and get a real question (spec §6).
    // The mapping is fixed, so the run-through you rehearse is the one you demo.
    wires: WIRE_COLORS.map((color) => ({
      color,
      status: "intact" as const,
      riddleId: riddleForWire(color).id,
      hintsGiven: 0,
      cutBy: null,
      cutAt: null,
    })),
    activeWire: null,
    deferred: [],

    durationSeconds: opts?.durationSeconds ?? DEFAULT_DURATION_SECONDS,
    startedAt: null,
    endedAt: null,
    pausedAt: null,
    pausedTotalMs: 0,
    penaltySeconds: 0,

    hintsUsed: 0,
    lifeline: {
      used: false,
      activeFor: null,
      callId: null,
      status: "idle",
      penaltyApplied: false,
      granted: false,
      requestedBy: null,
      since: Date.now(),
    },
    wrongAnswers: [],

    lastSpeaker: null,
    contested: false,

    events: [],
    seq: 0,
  };

  store.games.set(code, game);
  return game;
}

export function getGame(code: string): Game | undefined {
  return store.games.get(code.toUpperCase());
}

/** For the host console, which lists rooms without knowing a code. */
export function listGames(): Game[] {
  return [...store.games.values()].sort((a, b) => b.seq - a.seq);
}

export function requireGame(code: string): Game {
  const game = getGame(code);
  if (!game) throw new Error(`No such room: ${code}`);
  return game;
}

/* -------------------------------------------------------------------------- */
/* Players                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * RTC uids are derived from the room code and seat rather than random, so a
 * player who reloads their phone comes back as the same uid. Attribution and
 * the 3D seat lighting both key off uid, and a reconnect that changed uid would
 * silently orphan a contestant mid-round.
 */
function uidFor(code: string, seat: number): number {
  let hash = 0;
  for (const ch of code) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
  return 20000 + hash * 10 + seat;
}

/** The agent's own uid, distinct from every player's. */
export function agentUidFor(code: string): number {
  return uidFor(code, 9);
}

export function addPlayer(
  game: Game,
  input: { name: string; phoneE164?: string | null; consent?: boolean },
): Player {
  /**
   * Is this somebody coming back, or somebody new?
   *
   * Matched on name OR phone number, because a reconnect has to be forgiving.
   * A contestant whose phone locked, or who lost wifi for a moment, or who typed
   * "subin" the second time instead of "Subin", must land back in their own seat
   * — a new seat would orphan their wire credits and light up the wrong chair on
   * the projector.
   *
   * The number is the stronger signal of the two, so it is checked first: names
   * collide and get typo'd, numbers do not.
   */
  const name = input.name.trim();
  const key = name.toLowerCase();

  const existing =
    (input.phoneE164
      ? game.players.find((p) => p.phoneE164 === input.phoneE164)
      : undefined) ??
    game.players.find((p) => p.name.trim().toLowerCase() === key);

  if (existing) {
    existing.connected = true;
    // Let them correct a typo'd name on the way back in.
    if (name) existing.name = name.slice(0, 24);
    if (input.phoneE164) existing.phoneE164 = input.phoneE164;
    if (input.consent !== undefined) existing.consent = input.consent;
    emit(game, "player_rejoined", {
      playerId: existing.id,
      name: existing.name,
      seat: existing.seat,
    });
    return existing;
  }

  if (game.players.length >= 4) {
    throw new Error("Room is full — four contestants maximum.");
  }

  const seat = game.players.length as 0 | 1 | 2 | 3;
  const player: Player = {
    id: `p${seat + 1}`,
    uid: uidFor(game.code, seat),
    name: name.slice(0, 24),
    seat,
    // Only stored when consent was actually given — spec §9.6.
    phoneE164: input.consent && input.phoneE164 ? input.phoneE164 : null,
    consent: Boolean(input.consent),
    connected: true,
    joinedAt: Date.now(),
    // Everyone starts in discussion. Going live is a deliberate act, which is
    // what makes "who is the host listening to" always answerable.
    peerMode: true,
  };

  game.players.push(player);
  emit(game, "player_joined", {
    playerId: player.id,
    name: player.name,
    seat: player.seat,
    uid: player.uid,
  });
  return player;
}

export function setConnected(game: Game, playerId: string, connected: boolean) {
  const player = findPlayer(game, playerId);
  if (!player || player.connected === connected) return;
  player.connected = connected;
  emit(game, "player_presence", { playerId, connected });
}

/* -------------------------------------------------------------------------- */
/* Peer Talk                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Toggle a contestant between discussing with the others and speaking to the
 * host.
 *
 * The audio consequence lives on the phone: peer mode on means the local track
 * is unpublished, so the agent literally cannot hear them. That is stronger
 * than asking the model to ignore someone — there is nothing to ignore.
 *
 * The *reason* this exists is that three people need to argue about an answer
 * before committing to it, and a host who hears the arguing will answer the
 * arguing. Peer Talk gives the room a private channel that costs no clock.
 */
export function setPeerMode(game: Game, playerId: string, peerMode: boolean) {
  const player = findPlayer(game, playerId);
  if (!player) throw new Error(`No such contestant: ${playerId}`);
  if (player.peerMode === peerMode) return player;

  player.peerMode = peerMode;

  const live = livePlayers(game);
  emit(game, "peer_mode_changed", {
    playerId,
    playerName: player.name,
    peerMode,
    live: live.map((p) => p.id),
    liveNames: live.map((p) => p.name),
  });

  // When exactly one contestant is live, attribution is not a guess — it is
  // arithmetic. Set it here so the host can use their name immediately.
  if (live.length === 1) {
    setSpeaker(game, live[0].id, false);
  } else if (live.length === 0) {
    setSpeaker(game, null, false);
  }

  return player;
}

/** Put everyone back into discussion — used at round end and by the host console. */
export function allPeerMode(game: Game, peerMode: boolean) {
  for (const player of game.players) player.peerMode = peerMode;
  emit(game, "peer_mode_all", {
    peerMode,
    live: livePlayers(game).map((p) => p.id),
  });
}

/* -------------------------------------------------------------------------- */
/* Clock                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The wire the round opens on.
 *
 * Fixed rather than random, for the same reason the riddle bank is fixed: the
 * run-through you rehearse has to be the run-through you demo. Red is the
 * coconut riddle — the one everybody in the room already knows, which is the
 * right way to open.
 */
export const OPENING_WIRE: WireColor = "red";

/**
 * Put a riddle on the table before the host opens his mouth.
 *
 * The host's greeting is spoken by TTS straight from `greeting_message`, with no
 * LLM turn behind it — so if the opening question is going to be in that
 * greeting, the wire has to be chosen *here*, on the server, before the agent
 * joins. Idempotent: if a wire is already active this returns it untouched
 * rather than re-announcing it.
 */
export function openRound(game: Game) {
  if (game.activeWire) {
    const wire = findWire(game, game.activeWire);
    if (wire && wire.status !== "cut") {
      return { wire, riddle: getRiddle(wire.riddleId) };
    }
  }

  const first =
    game.wires.find((w) => w.color === OPENING_WIRE && w.status !== "cut") ??
    game.wires.find((w) => w.status !== "cut");
  if (!first) return null;

  return selectWire(game, first.color);
}

export function startGame(game: Game): Game {
  if (game.phase !== "lobby") return game;
  if (game.players.length === 0) throw new Error("No contestants have joined.");

  /**
   * A solo round starts on air.
   *
   * Peer Talk is a private channel between contestants, so with one contestant
   * it has nothing on the other end — leaving them in it means the host asks a
   * question and cannot hear the only person in the room. There is no way for
   * that to be what anybody wanted, so the server decides it rather than
   * hoping the player finds the button. The phone mirrors this on its side.
   */
  if (game.players.length === 1 && game.players[0].peerMode) {
    setPeerMode(game, game.players[0].id, false);
  }

  game.phase = "running";
  game.startedAt = Date.now();
  // Belt and braces: the agent route opens the round before the host greets, but
  // a start that came from the host console alone must not leave the table bare.
  openRound(game);
  emit(game, "game_started", {
    durationSeconds: game.durationSeconds,
    players: game.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
  });
  return game;
}

/**
 * Every clock change in the game funnels through here.
 *
 * `seconds` positive burns time, negative refunds it. One function means one
 * place to audit, and it means a refund is literally the same operation as a
 * penalty — which is why the Vobiz failure refund in §9.4 is three lines rather
 * than a special case.
 */
export function adjustClock(
  game: Game,
  seconds: number,
  reason: string,
): { secondsLeft: number } {
  if (game.phase !== "running") return { secondsLeft: secondsLeft(game) };

  game.penaltySeconds += seconds;
  // A refund must never hand back more time than the round ever had.
  const floor = -(game.durationSeconds);
  if (game.penaltySeconds < floor) game.penaltySeconds = floor;

  emit(game, seconds >= 0 ? "penalty" : "refund", {
    seconds: Math.abs(seconds),
    reason,
    secondsLeft: secondsLeft(game),
  });

  checkTimeout(game);
  return { secondsLeft: secondsLeft(game) };
}

export function pauseClock(game: Game) {
  if (game.phase !== "running" || game.pausedAt !== null) return;
  game.pausedAt = Date.now();
  emit(game, "clock_paused", { secondsLeft: secondsLeft(game) });
}

export function resumeClock(game: Game) {
  if (game.pausedAt === null) return;
  game.pausedTotalMs += Date.now() - game.pausedAt;
  game.pausedAt = null;
  emit(game, "clock_resumed", { secondsLeft: secondsLeft(game) });
}

/**
 * Nothing waits forever.
 *
 * Vobiz webhooks are the only thing that advances a call from dialing to
 * connected to done, and one that never arrives — a lost request, a stale
 * tunnel, a carrier going quiet — would pin the call open. That is not a stuck
 * indicator: the host is muted for the duration of a call, so a call that never
 * ends is a host who never speaks again, for the rest of the round.
 *
 * So every state has a deadline and this sweeps it. Runs on the SSE tick, which
 * means once a second while anything is watching.
 */
export function sweepLifeline(game: Game) {
  const { status, since } = game.lifeline;
  const limit = lifelineLimit(status);
  if (limit === 0) return;

  const waited = (Date.now() - since) / 1000;
  if (waited < limit) return;

  if (status === "dialing" || status === "ringing") {
    // Never answered. Refund in full and hand the lifeline back — the team is
    // not paying for a call that did not happen.
    lifelineFailed(game, `no answer within ${limit}s`);
    return;
  }

  // Answered, but no hangup ever arrived. The 45s window is long past; close it
  // so the host is released.
  emit(game, "lifeline_timeout", { waited: Math.round(waited) });
  lifelineEnded(game);
}

/**
 * Called from every mutation rather than from a timer, plus a slow poll in the
 * SSE route. There is no authoritative tick — see the note on `secondsLeft`.
 */
export function checkTimeout(game: Game): boolean {
  if (game.phase !== "running") return false;
  if (secondsLeft(game) > 0) return false;
  endGame(game, "lost", "clock expired");
  return true;
}

/* -------------------------------------------------------------------------- */
/* Wires                                                                      */
/* -------------------------------------------------------------------------- */

export function selectWire(game: Game, color: WireColor) {
  const wire = findWire(game, color);
  if (!wire) throw new Error(`No such wire: ${color}`);
  if (wire.status === "cut") throw new Error(`The ${color} wire is already cut.`);

  game.activeWire = color;
  // Selecting a deferred wire is how the host "comes back to it" (spec §6).
  game.deferred = game.deferred.filter((c) => c !== color);
  if (wire.status === "deferred") wire.status = "intact";

  const riddle = getRiddle(wire.riddleId);
  emit(game, "wire_selected", {
    color,
    riddleId: wire.riddleId,
    screen: riddle?.screen ?? "",
    hintsGiven: wire.hintsGiven,
  });
  return { wire, riddle };
}

/**
 * Cut a wire. Only ever called after a *semantically* correct answer — the
 * judging happens in the LLM layer, deliberately, because "wo brown wala fruit"
 * has to pass and no matcher written here would let it.
 *
 * `requireActive` is the one thing the server can check about a cut without
 * doing the judging itself: that the wire being cut is the wire that was
 * actually on the table. The model reaches this through `cut_wire` with the
 * guard ON, because a colour it drifted onto — the one it just asked about, the
 * one somebody named while thinking aloud — would otherwise cut a wire whose
 * riddle was never even asked. The host console's force-cut passes it OFF: that
 * is a human deliberately overriding, which is the whole point of the button.
 */
export function cutWire(
  game: Game,
  color: WireColor,
  answeredBy: string | null,
  opts: { requireActive?: boolean } = {},
) {
  if (game.phase !== "running") throw new Error("The round is not running.");

  const wire = findWire(game, color);
  if (!wire) throw new Error(`No such wire: ${color}`);
  if (wire.status === "cut") throw new Error(`The ${color} wire is already cut.`);

  if (opts.requireActive && game.activeWire !== color) {
    throw new Error(
      game.activeWire
        ? `The ${color} wire is not in play — ${game.activeWire} is. Nothing was cut. If they answered the ${color} riddle, call select_wire first.`
        : `No wire is in play, so there was no question to answer. Nothing was cut. Ask which wire they want and call select_wire.`,
    );
  }

  wire.status = "cut";
  wire.cutBy = answeredBy;
  wire.cutAt = Date.now();
  game.deferred = game.deferred.filter((c) => c !== color);
  if (game.activeWire === color) game.activeWire = null;

  const player = answeredBy ? findPlayer(game, answeredBy) : undefined;
  emit(game, "wire_cut", {
    color,
    answeredBy,
    answeredByName: player?.name ?? null,
    wiresRemaining: game.wires.filter((w) => w.status !== "cut").length,
    secondsLeft: secondsLeft(game),
  });

  if (allWiresCut(game)) endGame(game, "won", "all wires cut");

  return {
    success: true,
    wiresRemaining: game.wires.filter((w) => w.status !== "cut").length,
    secondsLeft: secondsLeft(game),
  };
}

/** Parking a wire is free — spec §5. The cost is that the host remembers. */
export function deferWire(game: Game, color: WireColor) {
  const wire = findWire(game, color);
  if (!wire) throw new Error(`No such wire: ${color}`);
  if (wire.status === "cut") throw new Error(`The ${color} wire is already cut.`);

  wire.status = "deferred";
  if (!game.deferred.includes(color)) game.deferred.push(color);
  if (game.activeWire === color) game.activeWire = null;

  emit(game, "wire_deferred", { color, deferred: game.deferred });
  return { deferred: game.deferred };
}

/**
 * Hand out the next hint for a wire and charge for it.
 *
 * The host is expected to have asked permission first — that is a prompt rule,
 * not something enforceable here, because the confirmation is the *point*
 * (spec §6, confirmation before consequence).
 */
export function giveHint(game: Game, color: WireColor) {
  const wire = findWire(game, color);
  if (!wire) throw new Error(`No such wire: ${color}`);

  const riddle = getRiddle(wire.riddleId);
  const hint = riddle?.hints[wire.hintsGiven];
  if (!hint) {
    return { hint: null, exhausted: true, secondsLeft: secondsLeft(game) };
  }

  wire.hintsGiven += 1;
  game.hintsUsed += 1;
  adjustClock(game, PENALTY_HINT, `hint on ${color}`);

  emit(game, "hint_given", { color, hint, index: wire.hintsGiven });
  return { hint, exhausted: false, secondsLeft: secondsLeft(game) };
}

/**
 * Record a wrong answer and charge for it.
 *
 * The text is kept verbatim because the *next* hint is generated from it —
 * "Nariyal nahi, aap food soch rahe ho" only works if the host knows what was
 * actually said. This list is also what powers cross-wire callbacks.
 */
export function recordWrongAnswer(
  game: Game,
  input: { playerId: string | null; text: string; wire: WireColor | null },
) {
  const player = input.playerId ? findPlayer(game, input.playerId) : undefined;

  game.wrongAnswers.push({
    playerId: player?.id ?? "unknown",
    playerName: player?.name ?? "someone",
    wire: input.wire ?? game.activeWire,
    text: input.text.slice(0, 120),
    at: Date.now(),
  });
  if (game.wrongAnswers.length > 40) game.wrongAnswers.shift();

  adjustClock(game, PENALTY_WRONG, `wrong answer: ${input.text.slice(0, 40)}`);
  emit(game, "wrong_answer", {
    playerId: player?.id ?? null,
    playerName: player?.name ?? null,
    text: input.text.slice(0, 120),
    wire: input.wire ?? game.activeWire,
  });

  return { secondsLeft: secondsLeft(game) };
}

/* -------------------------------------------------------------------------- */
/* Phone a Friend                                                             */
/* -------------------------------------------------------------------------- */

export function beginLifeline(game: Game, playerId: string, callId: string) {
  if (game.lifeline.used) throw new Error("The lifeline has already been used.");

  const player = findPlayer(game, playerId);
  if (!player) throw new Error(`No such contestant: ${playerId}`);
  if (!player.phoneE164 || !player.consent) {
    throw new Error(`${player.name} did not give a number with consent.`);
  }

  // Marked used at dial time so a second press cannot race in, but the *cost*
  // is only charged on answer — spec §9.4.
  game.lifeline = {
    used: true,
    activeFor: playerId,
    callId,
    status: "dialing",
    penaltyApplied: false,
    granted: true,
    // The request has been acted on.
    requestedBy: null,
    since: Date.now(),
  };
  emit(game, "lifeline_dialing", { playerId, playerName: player.name, callId });
  return game.lifeline;
}

/** Charge the 45s here, and here only — never on dial. Ring time is free. */
export function lifelineAnswered(game: Game) {
  if (game.lifeline.penaltyApplied) return;
  game.lifeline.status = "connected";
  game.lifeline.penaltyApplied = true;
  game.lifeline.since = Date.now();
  adjustClock(game, PENALTY_LIFELINE, "phone a friend connected");
  // Acknowledge it out loud, then say nothing until the call ends — the proxy
  // enforces the silence.
  hostSay(game.code, LIFELINE_LINES.connected);
  emit(game, "lifeline_connected", {
    playerId: game.lifeline.activeFor,
    seconds: PENALTY_LIFELINE,
  });
}

export function lifelineEnded(game: Game) {
  const playerId = game.lifeline.activeFor;
  game.lifeline.status = "done";
  game.lifeline.activeFor = null;
  game.lifeline.since = Date.now();
  // Hand the floor back and ask what they got — the whole point of the lifeline
  // is that they relay it to the room.
  hostSay(game.code, LIFELINE_LINES.ended);
  emit(game, "lifeline_ended", { playerId });
}

/**
 * Nobody picked up, or the carrier failed. Full refund and the lifeline goes
 * back on the shelf — spec §9.4. Requirement #9 asks what happens when an
 * external API fails; this is the answer, and it is visible on screen.
 */
export function lifelineFailed(game: Game, reason: string) {
  const playerId = game.lifeline.activeFor;

  if (game.lifeline.penaltyApplied) {
    adjustClock(game, -PENALTY_LIFELINE, `lifeline refund: ${reason}`);
  }
  game.lifeline = {
    used: false,
    activeFor: null,
    callId: null,
    status: "failed",
    penaltyApplied: false,
    // Permission survives the failure. They were told yes; a carrier fault is
    // not a reason to make them ask again.
    granted: true,
    requestedBy: null,
    since: Date.now(),
  };

  // Requirement #9 out loud: the failure is stated, not hidden.
  hostSay(game.code, LIFELINE_LINES.failed);
  emit(game, "lifeline_failed", { playerId, reason, refunded: true });
}

/**
 * A contestant tapped Phone a Friend.
 *
 * This deliberately does NOT dial. It raises a flag that reaches the host in
 * LIVE STATE so he can offer the trade out loud and wait for a yes — the tap is
 * how they ask, not how it happens. Requirement: confirmation before an
 * irreversible, costly action.
 */
export function requestLifeline(game: Game, playerId: string) {
  if (game.lifeline.used) {
    throw new Error("The lifeline has already been used.");
  }
  const player = findPlayer(game, playerId);
  if (!player) throw new Error(`No such contestant: ${playerId}`);

  game.lifeline.requestedBy = playerId;
  emit(game, "lifeline_requested", {
    playerId,
    playerName: player.name,
    hasNumber: player.phoneE164 !== null,
  });
  return game.lifeline;
}

/**
 * The host says yes.
 *
 * Unlocks the button without dialling. The contestant still has to press it,
 * which keeps the irreversible, clock-spending act in the hand of the person
 * whose clock it is.
 */
export function grantLifeline(game: Game, playerId?: string | null) {
  if (game.lifeline.used) throw new Error("The lifeline has already been used.");

  game.lifeline.granted = true;
  const target = playerId ?? game.lifeline.requestedBy;
  if (target) game.lifeline.requestedBy = target;

  const player = target ? findPlayer(game, target) : undefined;
  emit(game, "lifeline_granted", {
    playerId: target ?? null,
    playerName: player?.name ?? null,
  });
  return game.lifeline;
}

/** They changed their mind, or the host talked them out of it. */
export function cancelLifelineRequest(game: Game) {
  if (!game.lifeline.requestedBy) return;
  const playerId = game.lifeline.requestedBy;
  game.lifeline.requestedBy = null;
  emit(game, "lifeline_request_cancelled", { playerId });
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

export function setSpeaker(
  game: Game,
  playerId: string | null,
  contested: boolean,
) {
  const changed = game.lastSpeaker !== playerId || game.contested !== contested;
  game.lastSpeaker = playerId;
  game.contested = contested;
  if (changed) {
    emit(game, "speaker_changed", { playerId, contested });
  }
}

/* -------------------------------------------------------------------------- */
/* End of round                                                               */
/* -------------------------------------------------------------------------- */

export function endGame(
  game: Game,
  outcome: "won" | "lost",
  reason: string,
) {
  if (game.phase === "won" || game.phase === "lost") return game;

  // Freeze the clock before anything reads it again — on a win the surviving
  // time is the score (spec §10.4), so it must stop at the instant of the cut.
  game.endedAt = Date.now();
  game.phase = outcome;

  const summary = {
    outcome,
    reason,
    secondsLeft: secondsLeft(game),
    wiresCut: game.wires.filter((w) => w.status === "cut").length,
    wiresRemaining: game.wires
      .filter((w) => w.status !== "cut")
      .map((w) => w.color),
    hintsUsed: game.hintsUsed,
    lifelineUsed: game.lifeline.used,
    wrongAnswers: game.wrongAnswers.length,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      wiresCut: game.wires.filter((w) => w.cutBy === p.id).length,
    })),
  };

  emit(game, "game_over", summary);

  /**
   * Silence the host.
   *
   * Fire-and-forget on purpose: the round is already over on every screen and a
   * slow REST call must not hold that up. If it fails the agent idles out on its
   * own — but leaving him talking over the scoreboard is the worse outcome, so
   * it is always attempted.
   */
  void fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/room/${game.code}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop" }),
  }).catch(() => {});

  // Consent was for one round. Drop the numbers the moment it ends — spec §9.6.
  for (const player of game.players) player.phoneE164 = null;

  return game;
}

export function resetGame(game: Game): Game {
  const fresh = createGame({
    code: game.code,
    durationSeconds: game.durationSeconds,
  });
  // Contestants keep their seats and uids across a re-run; only numbers are
  // gone, because those were dropped at the end of the previous round.
  fresh.players = game.players.map((p) => ({ ...p, phoneE164: null }));
  emit(fresh, "game_reset", { code: fresh.code });
  return fresh;
}

export { livePlayers, publicView, secondsLeft };

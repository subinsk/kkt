/**
 * Rules check for the game engine.
 *
 * Not a unit-test suite — it is a scripted round that asserts the things which
 * would be humiliating to get wrong in front of judges: that the clock only
 * moves when it should, that a wire cannot be cut twice, that a failed lifeline
 * refunds in full, and that phone numbers are gone by the time the round ends.
 *
 *   npm run check:engine
 */

import {
  addPlayer,
  allPeerMode,
  createGame,
  getGame,
  listGames,
  msUntilExpiry,
  cutWire,
  deferWire,
  endGame,
  giveHint,
  lifelineAnswered,
  lifelineFailed,
  beginLifeline,
  pauseClock,
  recordUserTurn,
  recordWrongAnswer,
  resetGame,
  resumeClock,
  openRound,
  OPENING_WIRE,
  selectWire,
  setPeerMode,
  startGame,
} from "../lib/game/store";
import {
  findPlayer,
  PENALTY_HINT,
  ROOM_TTL_MS,
  PENALTY_LIFELINE,
  PENALTY_WRONG,
  WIRE_COLORS,
  wiresBy,
  wiresRemaining,
  livePlayers,
  secondsLeft,
  publicView,
} from "../lib/game/state";
import { RIDDLES, answerKey, riddleForWire } from "../lib/game/riddles";
import { checkSpokenClaims, sanitizeSpoken } from "../lib/llm";
import {
  AGORA_FAILURE_LINE,
  FILLER_PHRASES,
  FILLER_PHRASE_MAX_CHARS,
  PROXY_FALLBACK_LINE,
  liveStateBlock,
  openingLine,
} from "../lib/agent-config";
import { SPEAK_TEXT_MAX_BYTES, fillerWordsConfig } from "../lib/agora-rest";
import { normaliseFrom, normaliseTo } from "../lib/vobiz";
import {
  DEGRADE_AFTER_MS,
  currentUtterance,
  isDegraded,
} from "../lib/game/state";
import {
  attribute,
  recordLevels,
  speechWindow,
  rememberAgentUtterance,
  setHolding,
  stripEcho,
} from "../lib/game/attribution";
import {
  applyAck,
  divergences,
  findUtterance,
  registerAgoraLines,
  registerUtterance,
  sweepUtterances,
} from "../lib/game/utterances";
import { LIFELINE_LINES } from "../lib/game/host-speak";
import {
  MAX_CUE_CHARS,
  SPOKEN_WORDS_PER_SECOND,
  advanceReveal,
  charsPerSecondFor,
  cueAt,
  newReveal,
  spokenDurationMs,
  toCues,
} from "../lib/subtitles";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function throws(label: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.log(`  FAIL ${label} — expected it to throw, it did not`);
  } catch {
    passed++;
    console.log(`  ok   ${label}`);
  }
}

console.log("\nKKT engine check\n");

/* -- setup ---------------------------------------------------------------- */
console.log("setup");
const game = createGame({ code: "TEST" });
check("five wires", game.wires.length === 5);
check(
  "each wire has its own riddle",
  new Set(game.wires.map((w) => w.riddleId)).size === 5,
);
check(
  "red wire is the coconut riddle",
  riddleForWire("red").accept.includes("nariyal"),
);

const rahul = addPlayer(game, { name: "Rahul" });
const priya = addPlayer(game, { name: "Priya" });
const amit = addPlayer(game, { name: "Amit", phoneE164: "+919999999999", consent: true });
check("three contestants seated", game.players.length === 3);
check("distinct rtc uids", new Set(game.players.map((p) => p.uid)).size === 3);
check("everyone starts in peer talk", livePlayers(game).length === 0);
check("consent gates the number", amit.phoneE164 === "+919999999999");

const noConsent = addPlayer(game, {
  name: "Guest",
  phoneE164: "+918888888888",
  consent: false,
});
check("number dropped without consent", noConsent.phoneE164 === null);
throws("room caps at four", () => addPlayer(game, { name: "Fifth" }));

const rejoined = addPlayer(game, { name: "rahul" });
check("same name rejoins the same seat", rejoined.id === rahul.id);

/* -- peer talk ------------------------------------------------------------ */
console.log("\npeer talk");
setPeerMode(game, rahul.id, false);
check("one live contestant", livePlayers(game).length === 1);
check(
  "single live speaker is attributed automatically",
  game.lastSpeaker === rahul.id,
  `got ${game.lastSpeaker}`,
);
setPeerMode(game, priya.id, false);
// The floor is exclusive now: Priya going live takes Rahul off air rather than
// joining him. Asserted properly in the "exclusive floor" section above.
check("a second contestant replaces the first", livePlayers(game).length === 1);
check("and it is the one who just pressed", game.lastSpeaker === priya.id);
setPeerMode(game, priya.id, true);
check("back to all-discussing", livePlayers(game).length === 0);
check("nobody attributed when silent", game.lastSpeaker === null);

/* -- an exclusive floor --------------------------------------------------- */
/**
 * One contestant on air at a time.
 *
 * This is what makes attribution exact rather than a mic-level argmax, so the
 * invariant is load-bearing: if two handsets are ever live together, the ledger
 * still reports `source: "live"` with confidence 1 and names one of them for no
 * reason. Worth asserting rather than trusting.
 */
console.log("\nexclusive floor");
{
  const g = createGame({ code: "EXCL" });
  const a = addPlayer(g, { name: "Rahul" });
  const b = addPlayer(g, { name: "Priya" });
  const c = addPlayer(g, { name: "Amit" });

  setPeerMode(g, a.id, false);
  check("one contestant goes live", livePlayers(g).map((p) => p.id).join() === a.id);

  setPeerMode(g, b.id, false);
  const live = livePlayers(g).map((p) => p.id);
  check("a second going live takes the first off air", live.join() === b.id, live.join());
  check("and never leaves two on air together", live.length === 1);
  check("the third was untouched and stays muted", findPlayer(g, c.id)?.peerMode === true);

  setPeerMode(g, b.id, true);
  check("stepping back leaves nobody live", livePlayers(g).length === 0);

  throws("and 'everybody live' is refused outright", () => allPeerMode(g, false));
  allPeerMode(g, true);
  check("while 'everybody to peer' still works", livePlayers(g).length === 0);
}

/* -- a parked wire is not a finished wire --------------------------------- */
/**
 * The conflict this prevents, seen live: four wires cut, the fifth *deferred*,
 * and the host announced the team had won — while the clock was still running
 * and the panel still showed five wires. The board and the server were in
 * perfect agreement; it was the host's belief that had drifted.
 *
 * The cause was a state block that listed `intact` and `cut` and left the model
 * to work out the rest. With one wire parked, "Intact wires: none" reads as a
 * clear board. AGENTS.md is explicit that the model is *told* state and never
 * computes it, so the count and the round's status are now both stated outright.
 */
console.log("\nparked is not finished");
{
  const g = createGame({ code: "PARK" });
  addPlayer(g, { name: "Rahul" });
  startGame(g);

  // Cut four, park the fifth — exactly the board from the screenshot.
  for (const color of ["red", "blue", "green", "white"] as const) {
    g.activeWire = color;
    cutWire(g, color, null);
  }
  selectWire(g, "yellow");
  deferWire(g, "yellow");

  check("four are cut", wiresBy(g, "cut").length === 4);
  check("none are intact", wiresBy(g, "intact").length === 0);
  check("but one is still to cut", wiresRemaining(g).length === 1);
  check("and it is the parked one", wiresRemaining(g)[0] === "yellow");
  check("the round has NOT been won", g.phase === "running");

  const block = liveStateBlock({
    secondsLeft: 35,
    intact: wiresBy(g, "intact"),
    cut: wiresBy(g, "cut"),
    deferred: g.deferred,
    remaining: wiresRemaining(g),
    phase: g.phase,
    activeWire: g.activeWire,
    activeRiddle: null,
    activeRiddleHints: [],
    hintsGivenOnActive: 0,
    activeAnswer: null,
    activeAccept: [],
    activeReject: [],
    nearMissNotes: "",
    hintsUsed: 0,
    lifelineUsed: false,
    lifelineStatus: "idle",
    lifelineRequestedBy: null,
    lastSpeaker: null,
    contested: false,
    wrongAnswers: [],
    players: ["Rahul"],
    paused: false,
  });

  check(
    "LIVE STATE says how many are still to cut, in words the host cannot misread",
    /STILL TO CUT: 1 of 5/.test(block),
    block.split("\n").find((l) => l.includes("STILL TO CUT")) ?? "line missing",
  );
  check("and names the parked wire as one of them", /STILL TO CUT: 1 of 5 — yellow/.test(block));
  check(
    "and states outright that the round is not over",
    /ROUND STATUS: RUNNING/.test(block) && /must not say it is/.test(block),
  );
  check(
    "so 'Intact wires: none' can no longer read as a clear board",
    block.includes("Intact wires: none") && block.includes("STILL TO CUT: 1"),
  );

  // And when the last one really does go, the status flips on its own.
  selectWire(g, "yellow");
  cutWire(g, "yellow", null);
  check("cutting the parked wire wins the round", g.phase === "won");
  check("and nothing remains", wiresRemaining(g).length === 0);
}

/* -- a claim the server knows is false never reaches the room ------------- */
/**
 * The exact failure, from the event log of a real round:
 *
 *   +175.7s  host_said  "बिलकुल सही! सफ़ेद तार कट गया। सभी पाँच तार कट गए — आप जीत गए"
 *   +336.8s  wire_cut   color=white
 *
 * The host announced the cut and the win and never called `cut_wire`. For the
 * hundred and sixty seconds in between he simply repeated that the team had won,
 * because as far as he was concerned there was nothing left to do — and the
 * contestant had to keep insisting before the action he had already announced
 * actually happened.
 *
 * LIVE STATE was right the whole time. Telling the model the truth is therefore
 * not sufficient, and these assert the last line of defence: the words are
 * checked against the board before they are spoken.
 */
console.log("\nfalse claims");
{
  /** Whatever we substitute must not itself contain a win claim. */
  const WIN_CLAIM_SHAPE = /(जीत\s*(गए|गये|गया)|आप\s*जीत)/;
  const dev = (cs: string[]) => cs;
  const fourCut = {
    cutDev: dev(["लाल", "नीला", "पीला", "हरा"]),
    remainingDev: dev(["सफ़ेद"]),
    phase: "running",
  };

  const theRealOne =
    "बिलकुल सही! सफ़ेद तार कट गया। सभी पाँच तार कट गए — आप जीत गए, सबिन!";
  const verdict = checkSpokenClaims(theRealOne, fourCut);
  check("the line from the live round is refused", !verdict.ok);
  check(
    "and something true is said instead",
    !verdict.ok &&
      verdict.correction.includes("सफ़ेद") &&
      !WIN_CLAIM_SHAPE.test(verdict.correction),
    !verdict.ok ? verdict.correction : "",
  );

  check(
    "a bare win claim while the round runs is refused",
    !checkSpokenClaims("आप जीत गए!", fourCut).ok,
  );
  check(
    "so is claiming every wire is cut",
    !checkSpokenClaims("सभी पाँच तार कट गए।", fourCut).ok,
  );
  check(
    "so is naming an uncut wire as cut",
    !checkSpokenClaims("सफ़ेद तार काट दिया जाता है।", fourCut).ok,
  );

  /* -- and none of this may touch what he legitimately says ------------- */
  check(
    "a cut he really did make passes untouched",
    checkSpokenClaims("बिलकुल सही! हरा तार कट गया। एक तार बाकी है।", fourCut).ok,
  );
  check(
    "asking the riddle passes untouched",
    checkSpokenClaims("सफ़ेद तार का सवाल — ऐसी कौन सी चीज़ है जो रोज़ आती है?", fourCut).ok,
  );
  check(
    "a wrong-answer nudge passes untouched",
    checkSpokenClaims("नहीं, वो जवाब नहीं है। फिर से सोचिए।", fourCut).ok,
  );
  check(
    "and the real win, once the server agrees, is spoken",
    checkSpokenClaims("सभी पाँच तार कट गए — आप जीत गए!", {
      cutDev: dev(["लाल", "नीला", "पीला", "हरा", "सफ़ेद"]),
      remainingDev: [],
      phase: "won",
    }).ok,
  );
}

/* -- the two phone number formats ----------------------------------------- */
/**
 * `from` takes E.164 *without* the plus; `to` takes it *with*. Both fields hold
 * "a phone number", both look right to a human, and guessing wrong surfaces only
 * as the host saying the call could not be placed. So the env is read forgivingly
 * and normalised in one place.
 */
console.log("\nphone number formats");
{
  check("a from-number keeps its digits and loses the plus", normaliseFrom("+918071579253") === "918071579253");
  check("and is left alone when already correct", normaliseFrom("918071579253") === "918071579253");
  check("spaces and dashes are cleaned out", normaliseFrom(" 91-807 157 9253 ") === "918071579253");
  check("a to-number gains the plus", normaliseTo("918094774065") === "+918094774065");
  check("and keeps it when present", normaliseTo("+918094774065") === "+918094774065");
  check("an empty to-number stays empty rather than becoming a bare plus", normaliseTo("") === "");
}

/* -- spoken script ------------------------------------------------------- */
/**
 * Every string that reaches TTS must be Devanagari.
 *
 * Sarvam Bulbul reads `target_language_code: hi-IN`, so a Roman line is not a
 * style slip — it is read as English, in an English accent, and you only find
 * out by listening. `hints[0]` is the worst case: it is pre-rendered straight to
 * WAV for the Phone a Friend call, with no model in the loop to rescue it.
 *
 * `screen` and the `nearMiss` keys are exempt on purpose — one is only ever read
 * with eyes, the other is matched against what a contestant said.
 */
console.log("\nspoken script");
const HAS_ROMAN = /[A-Za-z]/;
for (const riddle of RIDDLES) {
  check(
    `${riddle.wire.padEnd(6)} riddle is Devanagari`,
    !HAS_ROMAN.test(riddle.speak),
    riddle.speak,
  );
  const romanHints = riddle.hints.filter((h) => HAS_ROMAN.test(h));
  check(
    `${riddle.wire.padEnd(6)} hints are Devanagari`,
    romanHints.length === 0,
    romanHints.join(" | "),
  );
  const romanLines = Object.values(riddle.nearMiss).filter((v) =>
    HAS_ROMAN.test(v),
  );
  check(
    `${riddle.wire.padEnd(6)} near-miss lines are Devanagari`,
    romanLines.length === 0,
    romanLines.join(" | "),
  );
  // A Devanagari key matters as much as a Devanagari line: the host writes its
  // wrong_answer argument in Devanagari, so a Roman-only key list would match
  // nothing and every diagnostic hint would silently fall back to generic.
  check(
    `${riddle.wire.padEnd(6)} near-miss can match a Hindi guess`,
    Object.keys(riddle.nearMiss).some((k) => !HAS_ROMAN.test(k)),
  );
}

/**
 * Filler phrases, measured.
 *
 * Agora caps a filler phrase containing non-Latin characters at 20 characters
 * and rejects the whole `/join` if one is over — so this is not a nicety, it is
 * the difference between a host in the room and a red 400 on the projector
 * thirty seconds before a demo. Devanagari spends characters fast; a phrase that
 * reads short can easily be 27.
 */
for (const phrase of FILLER_PHRASES) {
  check(
    `filler "${phrase}" fits Agora's ${FILLER_PHRASE_MAX_CHARS}-char cap`,
    phrase.length <= FILLER_PHRASE_MAX_CHARS,
    `${phrase.length} characters`,
  );
}
check(
  "filler phrases are Devanagari",
  !FILLER_PHRASES.some((f) => HAS_ROMAN.test(f)),
);

/**
 * The filler_words payload shape.
 *
 * `trigger` takes `fixed_time_config` and `content` takes `static_config` —
 * neither is plain `config`, and the asymmetry is exactly what got this wrong.
 * Agora accepts the request either way and then ignores the threshold, so there
 * is no 400 to notice and no log line to read: fillers simply fire on the server
 * default instead of the number in the file. See docs/AGORA-NOTES.md, 24 Aug
 * 2026, where the key names are confirmed against all four samples on the page.
 */
const filler = fillerWordsConfig();
check(
  "filler trigger uses fixed_time_config, not config",
  typeof filler.trigger.fixed_time_config?.response_wait_ms === "number",
  `keys: ${Object.keys(filler.trigger).join(", ")}`,
);
check(
  "filler content uses static_config",
  Array.isArray(filler.content.static_config?.phrases),
);
check(
  "filler response_wait_ms is inside Agora's documented 100–10000 range",
  filler.trigger.fixed_time_config.response_wait_ms >= 100 &&
    filler.trigger.fixed_time_config.response_wait_ms <= 10000,
  `${filler.trigger.fixed_time_config.response_wait_ms}ms`,
);

/**
 * Every line the host is made to say verbatim, measured.
 *
 * Two independent ways these fail silently. `/speak` caps `text` at **512
 * bytes**, not characters, and Devanagari spends three bytes per code point — so
 * the real ceiling is about 170 characters and a line that reads short can be
 * over it. And a Roman-script line is read as English by Bulbul, which is the
 * repo-wide rule these two fallbacks were quietly breaking.
 */
for (const [name, line] of Object.entries(LIFELINE_LINES)) {
  check(
    `lifeline line "${name}" fits the /speak 512-byte cap`,
    Buffer.byteLength(line, "utf8") <= SPEAK_TEXT_MAX_BYTES,
    `${Buffer.byteLength(line, "utf8")} bytes`,
  );
  check(`lifeline line "${name}" is Devanagari`, !HAS_ROMAN.test(line));
}
check(
  "the proxy's own fallback line is Devanagari",
  !HAS_ROMAN.test(PROXY_FALLBACK_LINE),
  PROXY_FALLBACK_LINE,
);
check(
  "Agora's llm.failure_message is Devanagari",
  !HAS_ROMAN.test(AGORA_FAILURE_LINE),
  AGORA_FAILURE_LINE,
);

/* -- solo round ----------------------------------------------------------- */
/**
 * One contestant, playing alone.
 *
 * This is here because the failure mode is silent in the worst way: the round
 * starts, the host asks a question, and the only person in the room is still in
 * Peer Talk — so nothing they say ever reaches the agent, and it looks like a
 * broken mic rather than a rule.
 */
console.log("\nsolo round");
const soloGame = createGame({ code: "SOLO" });
const alone = addPlayer(soloGame, { name: "Nikhil" });
throws("an empty room still cannot start", () =>
  startGame(createGame({ code: "EMPTY" })),
);
startGame(soloGame);
check("one contestant is enough to start", soloGame.phase === "running");
check(
  "starting opens on a wire rather than an empty table",
  soloGame.activeWire === OPENING_WIRE,
  `active: ${soloGame.activeWire}`,
);
check(
  "the solo contestant is on air, not in peer talk",
  livePlayers(soloGame).length === 1,
  `live: ${livePlayers(soloGame).length}`,
);
check(
  "solo speech is attributed without guessing",
  soloGame.lastSpeaker === alone.id,
  `got ${soloGame.lastSpeaker}`,
);
check("public view agrees they are live", publicView(soloGame).live.length === 1);
setPeerMode(soloGame, alone.id, true);
check(
  "a solo contestant can still mute themselves",
  livePlayers(soloGame).length === 0,
);
const reopened = openRound(soloGame);
check(
  "opening the round twice does not move the question",
  reopened?.wire.color === OPENING_WIRE,
);
check(
  "the opening wire has a speakable riddle",
  (reopened?.riddle?.speak ?? "").length > 0,
);
/**
 * A budget, not a style note. The countdown starts as this line is spoken, so
 * every word added to the opening is a word taken off the round — and an
 * opening that quietly grew to fifty seconds is a fifth of the game gone with
 * nothing on screen to show it.
 */
const openingWords = openingLine({
  players: ["Rahul", "Priya", "Amit"],
  wire: "red",
  riddle: riddleForWire("red").speak,
}).split(/\s+/).length;
check(
  "the opening stays inside its clock budget",
  openingWords <= 80,
  `${openingWords} words — roughly ${Math.round(
    openingWords / SPOKEN_WORDS_PER_SECOND,
  )}s of the 360s round`,
);
/**
 * Nobody is greeted by name. The line is TTS'd verbatim, so a Roman-script name
 * inside a Devanagari sentence is the one word Bulbul reads as English. The host
 * uses names constantly from his first LLM turn onwards, where they are spelled
 * in Devanagari.
 */
check(
  "the opening line names nobody",
  !openingLine({ players: ["Nikhil"], wire: "red", riddle: "R" }).includes(
    "Nikhil",
  ),
);
/**
 * The rules are only ever spoken here. The system prompt tells the host he has
 * already explained them, so if they fall out of this line the room never hears
 * them and nothing anywhere errors.
 */
for (const rule of ["पाँच तार", "छह मिनट", "हिंट", "फ़ोन अ फ्रेंड"]) {
  check(
    `the opening explains the rules — ${rule}`,
    openingLine({ players: ["Nikhil"], wire: "red", riddle: "R" }).includes(rule),
  );
}
check(
  "a solo contestant is not told to press On Air",
  !openingLine({ players: ["Nikhil"], wire: "red", riddle: "R" }).includes(
    "On Air",
  ),
);
check(
  "a group is told how to become audible",
  openingLine({ players: ["Nikhil", "Priya"], wire: "red", riddle: "R" }).includes(
    "On Air",
  ),
);


/* -- clock ---------------------------------------------------------------- */
console.log("\nclock");
check("lobby clock is full", secondsLeft(game) === 360);
throws("cannot cut before the round starts", () => cutWire(game, "red", null));

startGame(game);
check("running", game.phase === "running");

const before = secondsLeft(game);
recordWrongAnswer(game, { playerId: rahul.id, text: "watermelon", wire: "red" });
check(
  `wrong answer costs ${PENALTY_WRONG}s`,
  Math.abs(before - secondsLeft(game) - PENALTY_WRONG) <= 1,
  `${before} -> ${secondsLeft(game)}`,
);
check("wrong answer is remembered for callbacks", game.wrongAnswers.length === 1);
check(
  "verbatim text kept for diagnostic hints",
  game.wrongAnswers[0].text === "watermelon",
);

selectWire(game, "red");
const beforeHint = secondsLeft(game);
const hint = giveHint(game, "red");
check("hint returned", typeof hint.hint === "string" && hint.hint!.length > 0);
check(
  `hint costs ${PENALTY_HINT}s`,
  Math.abs(beforeHint - secondsLeft(game) - PENALTY_HINT) <= 1,
);
giveHint(game, "red");
giveHint(game, "red");
const exhausted = giveHint(game, "red");
check("hints run out", exhausted.exhausted === true);
const afterExhausted = secondsLeft(game);
giveHint(game, "red");
check(
  "an exhausted hint is free",
  Math.abs(afterExhausted - secondsLeft(game)) <= 1,
);

pauseClock(game);
const paused = secondsLeft(game);
check("pause holds the clock", game.pausedAt !== null);
resumeClock(game);
check(
  "resume does not lose time",
  Math.abs(paused - secondsLeft(game)) <= 1,
  `${paused} -> ${secondsLeft(game)}`,
);

/* -- wires ---------------------------------------------------------------- */
console.log("\nwires");
cutWire(game, "red", rahul.id);
check("red is cut", game.wires.find((w) => w.color === "red")!.status === "cut");
check("credited to the contestant", game.wires.find((w) => w.color === "red")!.cutBy === rahul.id);
throws("cannot cut the same wire twice", () => cutWire(game, "red", rahul.id));
throws("cannot select a cut wire", () => selectWire(game, "red"));

const beforeDefer = secondsLeft(game);
deferWire(game, "blue");
check("blue is parked", game.deferred.includes("blue"));
check("deferring is free", Math.abs(beforeDefer - secondsLeft(game)) <= 1);
selectWire(game, "blue");
check("selecting a parked wire un-parks it", !game.deferred.includes("blue"));

/* -- lifeline ------------------------------------------------------------- */
console.log("\nphone a friend");
throws("no lifeline without consent", () => beginLifeline(game, priya.id, "LL-x"));

beginLifeline(game, amit.id, "LL-1");
check("marked used at dial time", game.lifeline.used === true);
const beforeAnswer = secondsLeft(game);
check("nothing charged for ringing", game.lifeline.penaltyApplied === false);

lifelineAnswered(game);
check(
  `${PENALTY_LIFELINE}s charged on answer`,
  Math.abs(beforeAnswer - secondsLeft(game) - PENALTY_LIFELINE) <= 1,
);

const beforeRefund = secondsLeft(game);
lifelineFailed(game, "no answer");
check(
  "failure refunds in full",
  Math.abs(secondsLeft(game) - beforeRefund - PENALTY_LIFELINE) <= 1,
  `${beforeRefund} -> ${secondsLeft(game)}`,
);
check("lifeline goes back on the shelf", game.lifeline.used === false);

/* -- endgame -------------------------------------------------------------- */
console.log("\nendgame");
for (const color of ["blue", "yellow", "green", "white"] as const) {
  cutWire(game, color, priya.id);
}
check("won when all five are cut", game.phase === "won");
check("clock frozen at the win", game.endedAt !== null);
const frozen = secondsLeft(game);
check("surviving time is the score", frozen > 0);

check(
  "phone numbers dropped at round end",
  game.players.every((p) => p.phoneE164 === null),
);
check(
  "public view never carries a number",
  !JSON.stringify(publicView(game)).includes("+91"),
);

const view = publicView(game);
check("public view exposes seat colours", view.players.every((p) => p.color));

/* -- judging ------------------------------------------------------------- */
/**
 * Two ways a wire gets cut when it should not have been, both of which look
 * like a working game right up until a judge answers "anda" and wins a wire.
 *
 *   1. The model judged an answer it was never given the answer to. `accept`
 *      sat unused in the riddle bank for weeks; `answerKey` is what puts it in
 *      front of the judge every turn.
 *   2. The model cut a colour that was merely mentioned rather than the one in
 *      play. The server cannot judge meaning, but it can insist the wire being
 *      cut is the wire whose riddle was actually asked.
 */
console.log("\njudging");
for (const wire of WIRE_COLORS) {
  const key = answerKey(wire);
  check(
    `${wire.padEnd(6)} has an answer for the judge`,
    key.answer.length > 0 && key.accept.length > 0,
  );
  check(
    `${wire.padEnd(6)} answer is Devanagari, as the host would say it`,
    !/[A-Za-z]/.test(key.answer),
    key.answer,
  );
  check(
    `${wire.padEnd(6)} names the wrong answers that sound right`,
    key.reject.length > 0,
  );
  check(
    `${wire.padEnd(6)} answer is not also on the reject list`,
    !key.reject.some((r) => r.toLowerCase() === key.answer.toLowerCase()),
  );
}

const judgeGame = createGame({ code: "JUDGE" });
addPlayer(judgeGame, { name: "Asha" });
startGame(judgeGame);
selectWire(judgeGame, "red");
throws("the host cannot cut a wire that is not in play", () =>
  cutWire(judgeGame, "green", null, { requireActive: true }),
);
check(
  "and the wire it tried to cut is untouched",
  judgeGame.wires.find((w) => w.color === "green")!.status === "intact",
);
cutWire(judgeGame, "red", null, { requireActive: true });
check(
  "the active wire still cuts normally",
  judgeGame.wires.find((w) => w.color === "red")!.status === "cut",
);
throws("and nothing can be cut with no wire in play", () =>
  cutWire(judgeGame, "blue", null, { requireActive: true }),
);
// The host console's force-cut is a human overriding on purpose, so it is the
// one path that skips the guard.
cutWire(judgeGame, "blue", null);
check(
  "host console force-cut still overrides",
  judgeGame.wires.find((w) => w.color === "blue")!.status === "cut",
);

/* -- what reaches the microphone ------------------------------------------ */
/**
 * Everything in `content` goes two places: the TTS voice and the on-screen
 * transcript. A model that writes its tool call as prose instead of emitting it
 * on the tool channel therefore gets read aloud to the room — and the open
 * models on Groq do this whenever a turn mixes speech with an action.
 */
console.log("\nspoken output");
check(
  "leaked tool arguments never reach the microphone",
  sanitizeSpoken('बिलकुल सही! cut_wire {"color": "red", "answered_by": "p1"}') ===
    "बिलकुल सही!",
  JSON.stringify(sanitizeSpoken('बिलकुल सही! cut_wire {"color": "red", "answered_by": "p1"}')),
);
check(
  "a trailing playerid is stripped",
  sanitizeSpoken("लाल तार कट गया। playerid: 1") === "लाल तार कट गया।",
  JSON.stringify(sanitizeSpoken("लाल तार कट गया। playerid: 1")),
);
check(
  "channel markers and tool_call tags are stripped",
  sanitizeSpoken("<|channel|>commentary<|message|><tool_call>get_state</tool_call> ठीक है।") ===
    "ठीक है।",
  JSON.stringify(sanitizeSpoken("<|channel|>commentary<|message|><tool_call>get_state</tool_call> ठीक है।")),
);
check(
  "a turn that was nothing but machinery becomes silence",
  sanitizeSpoken('{"color": "red"}') === "",
  JSON.stringify(sanitizeSpoken('{"color": "red"}')),
);
check(
  "reasoning still never reaches the microphone",
  sanitizeSpoken("<think>she said coconut</think>बिलकुल सही!") === "बिलकुल सही!",
);
check(
  "ordinary Hindi is left completely alone",
  sanitizeSpoken("नारियल? बिलकुल सही! लाल तार कट गया। अब कौन सा तार?") ===
    "नारियल? बिलकुल सही! लाल तार कट गया। अब कौन सा तार?",
);

/* -- subtitles ------------------------------------------------------------ */

/**
 * The speech bubble sits in front of the wire panel, which is the one thing on
 * screen the audience actually has to read. So the guarantee being asserted here
 * is a size guarantee, not a formatting nicety: no card ever exceeds the box it
 * is drawn in, whatever the host emits. A model that ignores its "one or two
 * sentences" instruction is not a hypothetical — it is a Tuesday.
 */
console.log("\nsubtitles");

const opening = openingLine({
  players: ["Rahul", "Priya"],
  wire: "red",
  riddle: riddleForWire("red").speak,
});

const SUBTITLE_CASES: { label: string; text: string }[] = [
  { label: "the opening line", text: opening },
  { label: "a normal two-sentence turn", text: "बिलकुल सही! लाल तार कट गया। अब कौन सा तार लेंगे?" },
  { label: "a short interjection", text: "हाँ?" },
  {
    label: "a run-on with no sentence break",
    text: "अरे वाह ".repeat(60),
  },
  {
    label: "a wall of text with no whitespace at all",
    text: "क".repeat(500),
  },
  { label: "a single character", text: "क" },
];

for (const { label, text } of SUBTITLE_CASES) {
  const cues = toCues(text);

  check(
    `${label} — every card fits the bubble`,
    cues.every((c) => c.text.length <= MAX_CUE_CHARS),
    `longest card ${Math.max(...cues.map((c) => c.text.length))} chars`,
  );

  /**
   * Offsets must climb. The reveal is paced by one cursor running over the whole
   * line, so a card that starts before the previous one did would replay text
   * already spoken — and a repeated offset means the splitter did not advance,
   * which is a hang rather than a glitch.
   */
  check(
    `${label} — card offsets advance`,
    cues.every((c, i) => i === 0 || c.start > cues[i - 1].start),
  );

  /**
   * Nothing may be dropped. Splitting on whitespace is allowed to lose the
   * spaces themselves, so the comparison is against the text with whitespace
   * removed — but every printing character the host said has to reach a card.
   */
  const strip = (v: string) => v.replace(/\s+/g, "");
  check(
    `${label} — no words are lost`,
    strip(cues.map((c) => c.text).join("")) === strip(text),
  );
}

/**
 * Walking the cursor from nothing to the full length is exactly what the render
 * loop does every frame, so it must never step outside a card. Before this, an
 * off-by-one in the lookup showed as a card flashing empty at every boundary.
 */
const walk = toCues(opening);
let everyStepValid = true;
for (let cursor = 0; cursor <= opening.length; cursor++) {
  const { text: card, shown } = cueAt(walk, cursor);
  if (shown.length > card.length || !card.startsWith(shown)) everyStepValid = false;
}
check("the reveal cursor never steps outside its card", everyStepValid);

check(
  "the last cursor position lands on the last card, fully shown",
  (() => {
    const { text: card, shown } = cueAt(walk, opening.length);
    return card === walk[walk.length - 1].text && shown === card;
  })(),
);

/* -- subtitle sync -------------------------------------------------------- */

/**
 * The reveal, driven by a synthetic audio track.
 *
 * The two properties asserted here are the whole point of the component, and
 * neither can be judged by reading the code: the subtitle must not start before
 * the voice does, and it must not finish before the voice does. The second one
 * is not cosmetic — the host'"'"'s line ENDS with the riddle, so a subtitle that
 * runs ahead prints the question before he has asked it, and on a wrong-answer
 * turn it prints the diagnostic hint early.
 *
 * The old implementation failed both. It started typing the moment the proxy
 * emitted the text, which is before Agora has even called TTS, and it paced at a
 * fixed 42ms per character, which finished the Devanagari opening in fourteen
 * seconds against thirty-two seconds of speech.
 */
console.log("\nsubtitle sync");

/**
 * Run the machine frame by frame over a described audio track.
 *
 * `silentMs` is the gap between the text arriving and the host being heard —
 * Agora'"'"'s TTS round trip. `speechMs` is how long he then talks for. Returns the
 * frames at which the first and last characters appeared.
 */
function playLine(
  text: string,
  { silentMs, speechMs, gapEveryMs = 0 }: {
    silentMs: number;
    speechMs: number;
    /** Insert a 200ms dip in the level this often, as real speech does. */
    gapEveryMs?: number;
  },
) {
  const cues = toCues(text);
  const charsPerSecond = charsPerSecondFor(text);
  const reveal = newReveal();
  const FRAME_MS = 1000 / 60;

  let firstShownAtMs = -1;
  let fullyShownAtMs = -1;
  let everVisibleWhileSilent = false;

  // Run past the end of the speech so the ending is observed too.
  const totalMs = silentMs + speechMs + 4000;

  for (let t = 0; t < totalMs; t += FRAME_MS) {
    const intoSpeech = t - silentMs;
    const speaking = intoSpeech >= 0 && intoSpeech < speechMs;
    // Real speech dips through the threshold between words.
    const inGap =
      gapEveryMs > 0 && speaking && intoSpeech % gapEveryMs > gapEveryMs - 200;
    const voiced = speaking && !inGap;

    const { visible } = advanceReveal(reveal, {
      dt: FRAME_MS / 1000,
      voiced,
      cues,
      total: text.length,
      charsPerSecond,
    });

    const showing = reveal.started && visible && reveal.cursor >= 1;
    if (showing && firstShownAtMs < 0) firstShownAtMs = t;
    if (showing && intoSpeech < 0) everVisibleWhileSilent = true;
    if (fullyShownAtMs < 0 && reveal.cursor >= text.length) fullyShownAtMs = t;
  }

  return {
    firstShownAtMs,
    fullyShownAtMs,
    everVisibleWhileSilent,
    cursor: reveal.cursor,
  };
}

const line = openingLine({
  players: ["Rahul", "Priya"],
  wire: "red",
  riddle: riddleForWire("red").speak,
});
const spokenMs = spokenDurationMs(line);

/* The realistic case: 1.2s of TTS latency, then he speaks for the estimate. */
const normal = playLine(line, { silentMs: 1200, speechMs: spokenMs, gapEveryMs: 1400 });

check(
  "nothing is shown during the TTS round trip",
  !normal.everVisibleWhileSilent,
);
check(
  "the first character lands within a beat of the voice starting",
  normal.firstShownAtMs >= 1200 && normal.firstShownAtMs < 1200 + 400,
  `shown at ${Math.round(normal.firstShownAtMs)}ms, voice at 1200ms`,
);
check(
  "the line is not fully revealed before the voice stops",
  normal.fullyShownAtMs >= 1200 + spokenMs * 0.9,
  `full at ${Math.round(normal.fullyShownAtMs)}ms, voice ends at ${Math.round(
    1200 + spokenMs,
  )}ms`,
);
check(
  "and it does finish, rather than stalling short",
  normal.cursor >= line.length,
  `cursor ${normal.cursor.toFixed(1)} of ${line.length}`,
);

/**
 * Sarvam faster than the estimate. The catch-up has to close the gap rather than
 * leave the last card half-drawn after he has stopped talking.
 */
const fast = playLine(line, { silentMs: 800, speechMs: spokenMs * 0.7, gapEveryMs: 1400 });
check(
  "a faster-than-estimated delivery still ends fully revealed",
  fast.cursor >= line.length,
  `cursor ${fast.cursor.toFixed(1)} of ${line.length}`,
);

/**
 * Sarvam slower than the estimate. The hold has to stop the subtitle running out
 * of text and printing the riddle early.
 */
const slow = playLine(line, { silentMs: 800, speechMs: spokenMs * 1.4, gapEveryMs: 1400 });
check(
  "a slower-than-estimated delivery never runs out of text early",
  slow.fullyShownAtMs >= 800 + spokenMs * 1.2,
  `full at ${Math.round(slow.fullyShownAtMs)}ms, voice ends at ${Math.round(
    800 + spokenMs * 1.4,
  )}ms`,
);

/**
 * Barge-in. A contestant cuts him off two seconds in; the rest of the line is
 * never spoken, so it must not be shown.
 */
const bargedIn = playLine(line, { silentMs: 600, speechMs: 2000 });
check(
  "a barge-in stops the subtitle instead of racing to the end",
  bargedIn.cursor < line.length,
  `cursor ${bargedIn.cursor.toFixed(1)} of ${line.length}`,
);
check(
  "and it finishes the card he was actually on",
  bargedIn.cursor === cueAt(toCues(line), Math.floor(bargedIn.cursor)).end,
);

/**
 * A screen that never hears him at all — the host console plays nothing, and a
 * projector can have autoplay blocked. Subtitles have to appear anyway.
 */
const deaf = playLine(line, { silentMs: 60000, speechMs: 0 });
check(
  "a screen with no audio still shows the line, on the estimate alone",
  deaf.firstShownAtMs > 0,
  `shown at ${Math.round(deaf.firstShownAtMs)}ms`,
);

/* -- loss path ------------------------------------------------------------ */
const lossGame = createGame({ code: "LOSS", durationSeconds: 60 });
addPlayer(lossGame, { name: "Solo" });
startGame(lossGame);
endGame(lossGame, "lost", "clock expired");
check("loss path ends the round", lossGame.phase === "lost");
check(
  "game_over event emitted",
  lossGame.events.some((e) => e.type === "game_over"),
);
check(
  "events carry monotonic sequence numbers",
  lossGame.events.every((e, i, all) => i === 0 || e.seq > all[i - 1].seq),
);

/* -- the utterance ledger ------------------------------------------------- */
/**
 * The acknowledgement machine.
 *
 * Every case here is a failure that is invisible without an assertion: nothing
 * throws, nothing logs, and the only symptom is the host and the screen
 * disagreeing in a room with an audience in it. They are driven with an injected
 * `now` and a fake re-speak, so a six-second deadline is tested in no time at all
 * and without a network.
 *
 * `phase` is set directly rather than through `startGame`, because these assert
 * the watchdog and not the round rules, and going in through the front door would
 * put a contestant on air — which the retry logic correctly refuses to talk over.
 */
console.log("\nutterance ledger");
{
  const mk = () => {
    const g = createGame({ code: "ACK1" });
    g.phase = "running";
    g.startedAt = Date.now();
    return g;
  };

  /* -- a line nobody ever heard: one retry, then give up ----------------- */
  {
    const g = mk();
    const u = registerUtterance(g, "turn", "लाल तार काटिए");
    const said: string[] = [];
    const t0 = Date.now();

    sweepUtterances(g, (t) => said.push(t), t0 + 100);
    check(
      "a pending line is left alone before its deadline",
      findUtterance(g, u.id)?.status === "pending",
    );

    sweepUtterances(g, (t) => said.push(t), t0 + 3000);
    check(
      "past the start deadline it is declared lost",
      findUtterance(g, u.id)?.status === "lost",
    );
    check("and it is re-spoken exactly once", said.length === 1, `${said.length}`);
    check("with the same words", said[0] === "लाल तार काटिए");

    // The retry is its own record, linked back, and carries attempt 2.
    const retry = g.utterances.items.find((x) => x.retryOf === u.id);
    check("the retry is a separate linked record", !!retry && retry.attempts === 2);

    // Nobody hears the retry either.
    sweepUtterances(g, (t) => said.push(t), t0 + 9000);
    check(
      "a retry nobody hears is abandoned, not retried again",
      retry !== undefined && findUtterance(g, retry.id)?.status === "abandoned",
    );
    check("so it is never spoken a third time", said.length === 1, `${said.length}`);
    check("and it is counted as a divergence", divergences(g).abandoned === 1);
  }

  /* -- a retry that no longer makes sense -------------------------------- */
  {
    const g = mk();
    g.activeWire = "red";
    const u = registerUtterance(g, "turn", "लाल तार का सवाल");
    const said: string[] = [];
    // The round moved on while the line was in flight.
    g.activeWire = "blue";
    sweepUtterances(g, (t) => said.push(t), Date.now() + 3000);
    check(
      "a line about a wire the round has left is abandoned, not re-asked",
      findUtterance(g, u.id)?.status === "abandoned",
    );
    check("and nothing is spoken", said.length === 0);
  }

  /* -- he started, so the room heard him --------------------------------- */
  {
    const g = mk();
    const u = registerUtterance(g, "turn", "एक दो तीन चार पाँच");
    const said: string[] = [];
    applyAck(g, { turnId: 11, status: "speaking", text: "एक दो तीन", atMs: Date.now() });
    check("a speaking ack claims the oldest waiting line", findUtterance(g, u.id)?.status === "speaking");

    sweepUtterances(g, (t) => said.push(t), Date.now() + 60_000);
    check(
      "a missing END ack fails OPEN — the line is closed, not re-spoken",
      findUtterance(g, u.id)?.status === "ended",
    );
    check(
      "because re-speaking would duplicate audio the room already got",
      said.length === 0,
    );
  }

  /* -- late acks are recorded, never applied ----------------------------- */
  {
    const g = mk();
    const u = registerUtterance(g, "turn", "देर से आया जवाब");
    sweepUtterances(g, () => {}, Date.now() + 3000);
    sweepUtterances(g, () => {}, Date.now() + 9000);
    // The original ends at `lost` and stays there — the retry is what gets
    // abandoned. `lost` is terminal precisely so the ack below cannot revive it.
    check("the original line is finished with", findUtterance(g, u.id)?.status === "lost");
    check(
      "and its retry is the record that was abandoned",
      g.utterances.items.find((x) => x.retryOf === u.id)?.status === "abandoned",
    );

    // Tie a turn id to it the way a real ack would, then ack it far too late.
    findUtterance(g, u.id)!.turnId = 42;
    const verdict = applyAck(g, {
      turnId: 42,
      status: "ended",
      text: "देर से आया जवाब",
      atMs: Date.now(),
    });
    check("a late ack is reported as late", verdict === "late");
    check(
      "and does NOT resurrect the line",
      findUtterance(g, u.id)?.status === "lost",
    );
    check("it is counted instead", divergences(g).lateAcks === 1);
  }

  /* -- idempotence, so any number of reporters is safe ------------------- */
  {
    const g = mk();
    registerUtterance(g, "turn", "दो बार बोला गया");
    const ack = {
      turnId: 7,
      status: "speaking" as const,
      text: "दो बार",
      atMs: Date.now(),
    };
    check("the first reporter is applied", applyAck(g, ack) === "applied");
    check("a second reporter saying the same thing is a no-op", applyAck(g, ack) === "duplicate");
    check(
      "so two open projectors are redundancy, not a race",
      g.utterances.items.filter((u) => u.turnId === 7).length === 1,
    );
  }

  /* -- what Agora says on its own ---------------------------------------- */
  {
    const g = mk();
    registerAgoraLines(FILLER_PHRASES, [AGORA_FAILURE_LINE]);
    applyAck(g, { turnId: 3, status: "speaking", text: "हम्म", atMs: Date.now() });
    const filler = g.utterances.items.find((u) => u.turnId === 3);
    check("an unprompted line we recognise is logged as a filler", filler?.origin === "filler");
    check("observed lines start already speaking, with no deadline to miss", filler?.status === "speaking");

    const said: string[] = [];
    sweepUtterances(g, (t) => said.push(t), Date.now() + 60_000);
    check("and a filler is never re-spoken — Agora chose it, not us", said.length === 0);

    applyAck(g, { turnId: 4, status: "speaking", text: "कुछ और ही बोल दिया", atMs: Date.now() });
    check(
      "a line nothing on our side chose is flagged unattributed",
      g.utterances.items.find((u) => u.turnId === 4)?.origin === "unattributed",
    );
    check("and counted", divergences(g).unattributed === 1);
  }

  /* -- an ack finds its own line, not merely the oldest one --------------- */
  /**
   * The intermittent failure this replaces: with several lines registered and
   * unspoken at once — a greeting still playing, a silence prod behind it — an
   * ack paired with whichever was registered first. A mismatch then invented an
   * `unattributed` line, left the real one pending until the watchdog re-spoke
   * it, and put a line on the bubble that the host was not saying.
   */
  {
    const g = mk();
    const first = registerUtterance(g, "greeting", "नमस्कार सभी को, खेल शुरू करते हैं");
    const second = registerUtterance(g, "turn", "लाल तार का सवाल सुनिए ध्यान से");

    // The SECOND line's transcript arrives first — Agora spoke it first.
    applyAck(g, {
      turnId: 40,
      status: "ended",
      text: "लाल तार का सवाल सुनिए ध्यान से",
      atMs: Date.now(),
    });
    check(
      "an ack matches the line whose words it carries, not the oldest waiting",
      findUtterance(g, second.id)?.turnId === 40,
      `matched ${findUtterance(g, first.id)?.turnId === 40 ? first.id : second.id}`,
    );
    check("the other line is left untouched", findUtterance(g, first.id)?.status === "pending");
    check("and nothing was invented", divergences(g).unattributed === 0);

    // Now the greeting's own transcript, mangled a little as TTS transcripts are.
    applyAck(g, {
      turnId: 41,
      status: "ended",
      text: "नमस्कार सभी को खेल शुरू करते हैं",
      atMs: Date.now(),
    });
    check("and the greeting then matches its own", findUtterance(g, first.id)?.turnId === 41);
    check("still nothing invented", divergences(g).unattributed === 0);
  }

  /* -- learning how fast he actually talks -------------------------------- */
  /**
   * Sarvam sends no word timings, so the subtitle reveal has to pace itself.
   * Paced by an assumption it drifts for the whole length of a line; paced by a
   * measurement it only varies within a sentence. These assert that the
   * measurement is taken only from turns that can teach something.
   */
  {
    const g = mk();
    const u = registerUtterance(g, "turn", "एक दो तीन चार पाँच छह सात आठ");
    applyAck(g, { turnId: 60, status: "speaking", text: "", atMs: Date.now() });
    // Backdate the start so the turn "took" four seconds for eight words.
    findUtterance(g, u.id)!.speakingAt = Date.now() - 4000;
    applyAck(g, { turnId: 60, status: "ended", text: "एक दो तीन", atMs: Date.now() });

    const rate = g.utterances.wordsPerSecond;
    check(
      "a completed turn teaches a real speaking rate",
      rate !== null && rate > 1.6 && rate < 2.4,
      String(rate),
    );

    // A turn cut off spent less time than its words needed — it must not teach.
    const before = g.utterances.wordsPerSecond;
    const v = registerUtterance(g, "turn", "बहुत लंबा वाक्य जो पूरा नहीं हुआ यहाँ");
    applyAck(g, { turnId: 61, status: "speaking", text: "", atMs: Date.now() });
    findUtterance(g, v.id)!.speakingAt = Date.now() - 200;
    applyAck(g, { turnId: 61, status: "interrupted", text: "बहुत", atMs: Date.now() });
    check(
      "an interrupted turn teaches nothing — it was cut short",
      g.utterances.wordsPerSecond === before,
    );

    // An absurd measurement is rejected rather than averaged in.
    const w = registerUtterance(g, "turn", "एक दो तीन चार पाँच छह");
    applyAck(g, { turnId: 62, status: "speaking", text: "", atMs: Date.now() });
    findUtterance(g, w.id)!.speakingAt = Date.now() - 30;
    applyAck(g, { turnId: 62, status: "ended", text: "एक", atMs: Date.now() });
    check(
      "an impossible rate is refused, not averaged in",
      g.utterances.wordsPerSecond === before,
      String(g.utterances.wordsPerSecond),
    );
  }

  /* -- the reveal uses the measured rate ---------------------------------- */
  {
    const line = "एक दो तीन चार पाँच छह सात आठ नौ दस";
    const fast = charsPerSecondFor(line, 4);
    const slow = charsPerSecondFor(line, 1);
    check("a faster measured rate reveals faster", fast > slow);
    check(
      "and with no measurement it falls back to the assumption",
      charsPerSecondFor(line, null) === charsPerSecondFor(line),
    );
  }

  /* -- degraded mode ------------------------------------------------------ */
  {
    const g = mk();
    check("a room with nobody reporting acks starts degraded", isDegraded(g.utterances));
    applyAck(g, { turnId: 1, status: "speaking", text: "सुन रहे हैं", atMs: Date.now() });
    check("one ack is enough to trust the transport", !isDegraded(g.utterances));
    check(
      "and it goes degraded again once the reporter goes quiet",
      isDegraded(g.utterances, Date.now() + DEGRADE_AFTER_MS + 1000),
    );
  }

  /* -- what the screens are handed --------------------------------------- */
  {
    const g = mk();
    const a = registerUtterance(g, "turn", "पहली लाइन");
    applyAck(g, { turnId: 21, status: "speaking", text: "पहली लाइन", atMs: Date.now() });
    const b = registerUtterance(g, "turn", "दूसरी लाइन");
    check(
      "a line still being spoken keeps the bubble, even with another queued",
      currentUtterance(g.utterances)?.id === a.id,
    );
    applyAck(g, { turnId: 21, status: "ended", text: "पहली लाइन", atMs: Date.now() });
    check(
      "and hands over once it has actually ended",
      currentUtterance(g.utterances)?.id === b.id,
    );
  }
}

/* -- who said that -------------------------------------------------------- */
/**
 * Attribution, which until today was dead code.
 *
 * `attribute()` was never called from anywhere: every `setSpeaker` passed
 * `contested: false` as a literal, so `game.contested` could not become true and
 * the host's contested-floor branch in the prompt was unreachable. Three phones
 * were streaming mic levels at 30Hz into a store nothing read.
 *
 * Since the floor became exclusive, the *normal* path is a certainty rather than
 * a measurement — one publisher, one possible speaker. The mic-level argmax below
 * it is kept and still tested, but only reachable by calling `attribute()`
 * directly, as these assertions do. That is deliberate: it is the fallback if the
 * exclusive rule is ever relaxed, and an untested fallback is not a fallback.
 */
console.log("\nattribution");
{
  const spk = (code: string) => {
    const g = createGame({ code });
    g.phase = "running";
    g.startedAt = Date.now();
    return g;
  };
  /** A burst of mic samples for one player, inside the telemetry window. */
  const speak = (code: string, playerId: string, level: number, n = 30) => {
    const now = Date.now();
    recordLevels(
      code,
      playerId,
      Array.from({ length: n }, (_, i) => ({ t: now - 400 + i * 10, level })),
    );
  };
  const win = (text: string) => speechWindow(text);

  /* -- the normal path: one publisher, so no guessing at all -------------- */
  {
    const g = spk("ATT1");
    const a = addPlayer(g, { name: "Rahul" });
    const b = addPlayer(g, { name: "Priya" });
    setPeerMode(g, a.id, false);
    // Priya's own handset hears her loudly — she is talking to the others.
    speak(g.code, b.id, 0.9, 60);
    speak(g.code, a.id, 0.05);

    const turn = recordUserTurn(g, "मेरा जवाब नारियल है");
    check(
      "with one contestant on air, attribution is certain rather than measured",
      turn.playerId === a.id && turn.source === "live",
      `${turn.playerName} via ${turn.source}`,
    );
    check("and never contested", !turn.contested && turn.confidence === 1);
    check(
      "a muted contestant cannot win on her own mic level — the agent never heard her",
      turn.playerId !== b.id,
    );
    check("the game records the speaker", g.lastSpeaker === a.id);
  }

  /* -- the fallback, driven directly ------------------------------------- */
  /**
   * Two candidates cannot arise from `setPeerMode` any more, so these call
   * `attribute()` with the candidate list a relaxed policy would produce.
   */
  {
    const g = spk("ATT2");
    const a = addPlayer(g, { name: "Rahul" });
    const b = addPlayer(g, { name: "Priya" });
    const both = [a.id, b.id];

    speak(g.code, a.id, 0.4);
    speak(g.code, b.id, 0.02);
    const clear = attribute(g.code, win("नारियल").startMs, Date.now(), both);
    check("with two candidates the loudest wins", clear.playerId === a.id);
    check("and the measurement is what decided it", clear.source === "level");
    check("not contested when the margin is wide", !clear.contested);
  }
  {
    const g = spk("ATT3");
    const a = addPlayer(g, { name: "Rahul" });
    const b = addPlayer(g, { name: "Priya" });
    speak(g.code, a.id, 0.30);
    speak(g.code, b.id, 0.28);
    const close = attribute(g.code, win("नारियल").startMs, Date.now(), [a.id, b.id]);
    check("two comparable speakers are flagged contested", close.contested);
    check("a name is still offered rather than nothing", close.playerId !== null);
    check(
      "confidence reports how close it was",
      close.confidence > 0.4 && close.confidence < 0.6,
      String(close.confidence),
    );
  }
  {
    const g = spk("ATT4");
    const a = addPlayer(g, { name: "Rahul" });
    const b = addPlayer(g, { name: "Priya" });
    speak(g.code, a.id, 0.05);
    speak(g.code, b.id, 0.30);
    setHolding(g.code, a.id, true);
    const held = attribute(g.code, win("मैं बोल रहा हूँ").startMs, Date.now(), [
      a.id,
      b.id,
    ]);
    check("hold-to-talk overrides a louder neighbour", held.playerId === a.id);
    check("and says so", held.source === "hold");
  }
  {
    const g = spk("ATT5");
    const a = addPlayer(g, { name: "Rahul" });
    const b = addPlayer(g, { name: "Priya" });
    speak(g.code, a.id, 0.001);
    speak(g.code, b.id, 0.001);
    const quiet = attribute(g.code, win("कुछ").startMs, Date.now(), [a.id, b.id]);
    check("below the noise floor nobody is named", quiet.playerId === null);
    check("and the source says so", quiet.source === "none");
  }
}

/* -- the host hearing himself --------------------------------------------- */
/**
 * The echo filter, and the answer it used to eat.
 *
 * In Mode A the room speaker leaks into three open phone mics and no AEC can
 * help, because the phone is not the device making the sound. The old filter
 * asked "is this turn an echo" and dropped the whole thing when it matched — so
 * a contestant answering *while* the host was still talking produced one ASR
 * turn containing both, the containment test matched, and their answer was
 * discarded before the model ever saw it. No error, no log line.
 */
console.log("\nself-echo");
{
  const g = createGame({ code: "ECHO" });
  g.phase = "running";
  const host = "लाल तार का सवाल — ऐसी कौन सी चीज़ है जिसके ऊपर बाल हैं";
  rememberAgentUtterance(g.code, host);

  check(
    "a pure echo is still recognised",
    stripEcho(g.code, host) === "",
  );
  check(
    "a slightly mangled echo is still recognised",
    stripEcho(g.code, host.replace("कौन सी", "कौनसी")) === "",
  );

  const mixed = `${host} नारियल`;
  const kept = stripEcho(g.code, mixed);
  check("an echo with an answer riding on it keeps the answer", kept.includes("नारियल"), kept);
  check("and drops the host's own sentence", !kept.includes("जिसके ऊपर बाल"), kept);

  check(
    "a short answer is never filtered, echo window or not",
    stripEcho(g.code, "हाँ") === "हाँ",
  );
  check(
    "an unrelated answer passes through untouched",
    stripEcho(g.code, "मुझे लगता है प्याज़") === "मुझे लगता है प्याज़",
  );

  // And the same thing through the real entry point.
  const turn = recordUserTurn(g, mixed);
  check("recorded as a real turn, not as echo", turn.status === "final");
  check("with the raw transcript kept for the record", turn.raw === mixed);
  const pure = recordUserTurn(g, host);
  check("while a pure echo is recorded as echo", pure.status === "echo");
  check("and hands the model nothing", pure.text === "");
}

/* -- the round ends cleanly, with everything else still running ----------- */
/**
 * What the endgame has to survive now that there are two watchdogs and a ledger
 * running alongside it.
 *
 * The failure this guards against is specific and would be very visible: the
 * host announcing a riddle over the scoreboard because a subtitle watchdog
 * decided a line was worth re-speaking after the game was already over.
 */
console.log("\nendgame interactions");
{
  /* -- a line in flight when the round ends is dropped, not re-spoken ----- */
  {
    const g = createGame({ code: "END1" });
    addPlayer(g, { name: "Rahul" });
    startGame(g);
    g.activeWire = "red";
    const u = registerUtterance(g, "turn", "लाल तार का सवाल");

    endGame(g, "lost", "clock expired");

    const said: string[] = [];
    // Well past the start deadline, so the watchdog would act if it were going to.
    sweepUtterances(g, (t) => said.push(t), Date.now() + 30_000);
    check(
      "a line still pending when the round ends is abandoned",
      findUtterance(g, u.id)?.status === "abandoned",
      findUtterance(g, u.id)?.status,
    );
    check(
      "and is NEVER re-spoken over the scoreboard",
      said.length === 0,
      said.join(" | "),
    );
  }

  /* -- the round still ends with the ledger mid-flight ------------------- */
  {
    const g = createGame({ code: "END2" });
    addPlayer(g, { name: "Rahul" });
    startGame(g);
    registerUtterance(g, "turn", "कुछ बोल रहे हैं");
    applyAck(g, { turnId: 91, status: "speaking", text: "कुछ", atMs: Date.now() });

    for (const color of WIRE_COLORS) {
      g.activeWire = color;
      cutWire(g, color, null);
    }
    check("all five cut still wins, ledger busy or not", g.phase === "won");
    check("and the clock is frozen", g.endedAt !== null);
  }

  /* -- ending twice must not double-fire -------------------------------- */
  {
    const g = createGame({ code: "END3" });
    addPlayer(g, { name: "Rahul" });
    startGame(g);
    endGame(g, "lost", "first");
    const seqAfterFirst = g.seq;
    endGame(g, "won", "second");
    check(
      "a second endGame is ignored — the outcome cannot be rewritten",
      g.phase === "lost",
    );
    check("and it emits nothing further", g.seq === seqAfterFirst);
  }

  /* -- nothing the room says after the whistle moves anything ----------- */
  {
    const g = createGame({ code: "END4" });
    const a = addPlayer(g, { name: "Rahul" });
    startGame(g);
    setPeerMode(g, a.id, false);
    endGame(g, "lost", "clock expired");
    const before = g.lastSpeaker;
    const turn = recordUserTurn(g, "अरे रुको, नारियल!");
    check(
      "a late answer is recorded but changes no outcome",
      g.phase === "lost" && turn.status === "final",
    );
    check("and cannot re-open the round", g.endedAt !== null);
    check("the speaker only moves if somebody was audible", g.lastSpeaker === before || turn.playerId !== null);
  }
}

/* -- room expiry ---------------------------------------------------------- */
/**
 * Rooms are in-memory and codes are minted per show, so a process left up across
 * a demo day would otherwise hold every abandoned room anyone opened, each with
 * its own event log and subscriber set.
 *
 * Silent in the way this project keeps producing: nothing errors, memory just
 * climbs and stale codes keep resolving. So the rule is asserted here — including
 * that expiry is *derived from a timestamp* rather than swept by a timer, which
 * is precisely why backdating `createdAt` is enough to make a room due.
 */
console.log("\nroom expiry");
const freshRoom = createGame({ code: "FRESH" });
const staleRoom = createGame({ code: "STALE" });

check(
  "a new room is not due to expire",
  msUntilExpiry(freshRoom) > 59 * 60 * 1000,
);

staleRoom.createdAt = Date.now() - ROOM_TTL_MS - 1;
check("a room past its TTL has no time left", msUntilExpiry(staleRoom) === 0);
check("looking it up drops it", getGame("STALE") === undefined);
check(
  "and it is gone from the room list",
  !listGames().some((g) => g.code === "STALE"),
);
check("while a fresh room survives the sweep", getGame("FRESH") !== undefined);
check(
  "expiry is announced before the room disappears",
  staleRoom.events.some((e) => e.type === "room_expired"),
);

/**
 * Re-running a room has to renew it, or a host who resets at minute fifty-nine
 * loses the room a minute into the second round.
 */
const reRun = createGame({ code: "RERUN" });
reRun.createdAt = Date.now() - 50 * 60 * 1000;
addPlayer(reRun, { name: "Asha" });
check(
  "resetting a room renews its hour",
  msUntilExpiry(resetGame(reRun)) > 59 * 60 * 1000,
);

console.log(
  `\n${passed} passed, ${failed} failed\n`,
);
process.exit(failed === 0 ? 0 : 1);

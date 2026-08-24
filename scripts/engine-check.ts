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
  PENALTY_HINT,
  ROOM_TTL_MS,
  PENALTY_LIFELINE,
  PENALTY_WRONG,
  WIRE_COLORS,
  livePlayers,
  secondsLeft,
  publicView,
} from "../lib/game/state";
import { RIDDLES, answerKey, riddleForWire } from "../lib/game/riddles";
import { sanitizeSpoken } from "../lib/llm";
import {
  FILLER_PHRASES,
  FILLER_PHRASE_MAX_CHARS,
  openingLine,
} from "../lib/agent-config";
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
check("two can go live together", livePlayers(game).length === 2);
setPeerMode(game, priya.id, true);
setPeerMode(game, rahul.id, true);
check("back to all-discussing", livePlayers(game).length === 0);
check("nobody attributed when silent", game.lastSpeaker === null);

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

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
  cutWire,
  deferWire,
  endGame,
  giveHint,
  lifelineAnswered,
  lifelineFailed,
  beginLifeline,
  pauseClock,
  recordWrongAnswer,
  resumeClock,
  selectWire,
  setPeerMode,
  startGame,
} from "../lib/game/store";
import {
  PENALTY_HINT,
  PENALTY_LIFELINE,
  PENALTY_WRONG,
  livePlayers,
  secondsLeft,
  publicView,
} from "../lib/game/state";
import { riddleForWire } from "../lib/game/riddles";
import { GREETING, greetingFor } from "../lib/agent-config";

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
check(
  "the greeting names a lone contestant",
  greetingFor(["Nikhil"]).includes("Nikhil"),
);
check(
  "a group still gets the group greeting",
  greetingFor(["Nikhil", "Priya"]) === GREETING,
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

console.log(
  `\n${passed} passed, ${failed} failed\n`,
);
process.exit(failed === 0 ? 0 : 1);

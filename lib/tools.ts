/**
 * The tool surface the host can act through — spec §8.
 *
 * Division of labour, and the whole reason this file exists:
 *
 *   The model decides *meaning*. Was "wo brown wala fruit" the right answer?
 *   Only a language model can rule on that, and spec §6 is explicit that a
 *   matcher here would embarrass us live.
 *
 *   The server decides *consequence*. How many seconds a wrong answer costs,
 *   whether the lifeline is still available, whether the wire is now cut. The
 *   model is never asked, and never trusted, on any of it.
 *
 * One deliberate departure from the spec: §8 sketches `penalize({ seconds })`.
 * Passing the number through the model would hand it the clock, which §7 spends
 * a paragraph forbidding. So the tool takes a *reason* and the server maps it to
 * a cost. Same call site, authority in the right place.
 */

import {
  PENALTY_HINT,
  PENALTY_WRONG,
  WIRE_COLORS,
  findPlayer,
  findWire,
  livePlayers,
  publicView,
  secondsLeft,
  wiresBy,
  type Game,
  type WireColor,
} from "./game/state";
import {
  cutWire,
  deferWire,
  grantLifeline,
  giveHint,
  recordWrongAnswer,
  requireGame,
  selectWire,
} from "./game/store";
import { answerKey, getRiddle, riddleForWire } from "./game/riddles";
import { startLifeline } from "./game/lifeline";

/* -------------------------------------------------------------------------- */
/* Definitions sent to the model                                              */
/* -------------------------------------------------------------------------- */

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "get_state",
      description:
        "Read the authoritative game state: clock, wire statuses, who is live, what has been guessed. Cheap — call this instead of guessing whenever you are unsure what is true.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "select_wire",
      description:
        "Make a wire the active one and get its riddle. Call this when the contestants choose a colour. Returns the riddle text to ask.",
      parameters: {
        type: "object",
        properties: {
          color: {
            type: "string",
            enum: [...WIRE_COLORS],
            description:
              "Wire colour in English, even if the contestant said laal/neela/peela/hara/safed.",
          },
        },
        required: ["color"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cut_wire",
      description:
        "Cut a wire. Call this ONLY after a contestant has said something that MEANS the ANSWER KEY shown for the active wire in LIVE STATE. Not for a good guess, not for a clever answer that fits the riddle, not for a question or a wire colour — only for the answer. The server refuses any wire that is not the active one, and a refused cut costs you a turn on air, so check before you call.",
      parameters: {
        type: "object",
        properties: {
          color: { type: "string", enum: [...WIRE_COLORS] },
          answered_by: {
            type: "string",
            description:
              "The contestant id who answered (p1, p2, p3). Omit only if genuinely unknown.",
          },
        },
        required: ["color"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "wrong_answer",
      description:
        "Record an incorrect answer. Costs the team time — the server decides how much. Returns diagnostic material about why that specific guess was wrong, which you should use to build your next hint.",
      parameters: {
        type: "object",
        properties: {
          answer_text: {
            type: "string",
            description: "What the contestant actually said, verbatim.",
          },
          player_id: {
            type: "string",
            description: "Who said it (p1, p2, p3), if known.",
          },
        },
        required: ["answer_text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_hint",
      description:
        "Get the next hint for a wire. Costs time, so you must have asked permission and received a yes before calling this.",
      parameters: {
        type: "object",
        properties: {
          color: {
            type: "string",
            enum: [...WIRE_COLORS],
            description: "Defaults to the active wire if omitted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "defer_wire",
      description:
        "Park a wire to come back to later. Free — costs no time. Use when contestants want to skip.",
      parameters: {
        type: "object",
        properties: { color: { type: "string", enum: [...WIRE_COLORS] } },
        required: ["color"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grant_lifeline",
      description:
        "Approve Phone a Friend for a contestant. Call this the moment they ask for it and you have told them the cost — it unlocks the button on their phone, it does NOT place the call and costs nothing. They then press it themselves, or you can call phone_a_friend for them if they ask you to dial.",
      parameters: {
        type: "object",
        properties: {
          player_id: {
            type: "string",
            description: "Who asked (p1, p2, p3). Omit if unclear.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "phone_a_friend",
      description:
        "Place a real phone call to the contestant's friend, who will hear the hint for the active wire. Once per game. Costs time from the moment the call connects, not from dialling. Only call this after the contestants confirm they want it.",
      parameters: {
        type: "object",
        properties: {
          player_id: {
            type: "string",
            description: "The contestant requesting the lifeline (p1, p2, p3).",
          },
        },
        required: ["player_id"],
      },
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Diagnostic hints — spec §6, "adaptive questioning"                         */
/* -------------------------------------------------------------------------- */

const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Find the pre-written retort for a specific wrong guess.
 *
 * This is not answer judging — the model already ruled the answer wrong. This
 * only picks which prepared line fits, so the host can say "Nariyal nahi, aap
 * food soch rahe ho" instead of a generic "sochiye". A canned hint reads as a
 * script; a hint that names *what you just said* reads as a person listening.
 */
function diagnoseWrongAnswer(wire: WireColor, answerText: string): string {
  const riddle = riddleForWire(wire);
  const said = norm(answerText);

  for (const [guess, retort] of Object.entries(riddle.nearMiss)) {
    const key = norm(guess);
    if (said.includes(key) || key.includes(said)) return retort;
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

function asWireColor(value: unknown): WireColor {
  const color = String(value ?? "").toLowerCase() as WireColor;
  if (!WIRE_COLORS.includes(color)) {
    throw new Error(
      `"${value}" is not a wire. Use one of: ${WIRE_COLORS.join(", ")}.`,
    );
  }
  return color;
}

/**
 * A compact state summary attached to every tool result.
 *
 * The model gets the clock back on every single call, so it can never drift
 * even within a multi-tool turn.
 */
function stateFor(game: Game) {
  return {
    seconds_left: secondsLeft(game),
    intact: wiresBy(game, "intact"),
    cut: wiresBy(game, "cut"),
    deferred: game.deferred,
    active_wire: game.activeWire,
    phase: game.phase,
    live_contestants: livePlayers(game).map((p) => ({ id: p.id, name: p.name })),
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  room: string,
): Promise<unknown> {
  const game = requireGame(room);

  switch (name) {
    case "get_state": {
      return {
        ok: true,
        ...publicView(game),
        // Spelled out because the model has to *use* these, not just see them.
        note:
          livePlayers(game).length === 0
            ? "Nobody is live right now — every contestant is in Peer Talk, discussing among themselves. Wait, or say something short to prompt them."
            : undefined,
      };
    }

    case "select_wire": {
      const color = asWireColor(args.color);
      const { wire, riddle } = selectWire(game, color);
      const key = answerKey(color);
      return {
        ok: true,
        color,
        // The Devanagari form, because this is what goes to TTS.
        riddle: riddle?.speak ?? "",
        riddle_roman: riddle?.screen ?? "",
        // The key travels with the riddle, so the judge never has to hold an
        // answer in its head across turns — LIVE STATE repeats it anyway.
        answer: key.answer,
        also_accept: key.accept,
        known_wrong: key.reject,
        instruction:
          "Ask the riddle. Judge every answer against `answer` — generous about wording, strict about meaning. Never say `answer` out loud, and never cut for anything in `known_wrong`.",
        hints_already_given: wire.hintsGiven,
        hints_remaining: Math.max(
          0,
          (riddle?.hints.length ?? 0) - wire.hintsGiven,
        ),
        ...stateFor(game),
      };
    }

    case "cut_wire": {
      const color = asWireColor(args.color);
      const answeredBy = args.answered_by ? String(args.answered_by) : null;

      // A player id the model invented would silently mis-credit the cut, and
      // the scoreboard is per-contestant.
      const player = answeredBy ? findPlayer(game, answeredBy) : undefined;
      // `requireActive`: the server cannot judge the answer, but it can insist
      // the wire being cut is the wire whose riddle was actually asked. A model
      // that drifts onto a colour somebody merely mentioned would otherwise cut
      // a wire nobody had been asked about.
      const result = cutWire(game, color, player?.id ?? null, {
        requireActive: true,
      });

      return {
        ok: true,
        ...result,
        color,
        credited_to: player?.name ?? "the team",
        ...stateFor(game),
      };
    }

    case "wrong_answer": {
      const text = String(args.answer_text ?? "").trim();
      if (!text) throw new Error("answer_text is required.");

      const playerId = args.player_id ? String(args.player_id) : null;
      const wire = game.activeWire;

      recordWrongAnswer(game, { playerId, text, wire });

      const diagnosis = wire ? diagnoseWrongAnswer(wire, text) : "";
      const riddle = wire ? riddleForWire(wire) : null;
      const wireState = wire ? findWire(game, wire) : undefined;
      const hintsLeft = riddle
        ? riddle.hints.length - (wireState?.hintsGiven ?? 0)
        : 0;

      return {
        ok: true,
        cost_seconds: PENALTY_WRONG,
        // If there is a prepared retort for this exact guess, the model is told
        // to use it rather than improvise something vaguer.
        diagnosis: diagnosis || null,
        instruction: diagnosis
          ? "Say this diagnosis in your own voice — it addresses their specific guess. Do not read it verbatim, and do not give away the answer."
          : "No prepared line for that guess. Nudge them from what they said, without revealing the answer.",
        hints_available: hintsLeft,
        hint_cost_seconds: PENALTY_HINT,
        ...stateFor(game),
      };
    }

    case "get_hint": {
      const color = args.color ? asWireColor(args.color) : game.activeWire;
      if (!color) {
        throw new Error("No active wire — call select_wire first.");
      }
      const result = giveHint(game, color);
      return {
        ok: true,
        color,
        hint: result.hint,
        exhausted: result.exhausted,
        cost_seconds: result.exhausted ? 0 : PENALTY_HINT,
        instruction: result.exhausted
          ? "There are no hints left on this wire. Say so plainly — no time was charged."
          : "Deliver this hint in character. It has already been paid for.",
        ...stateFor(game),
      };
    }

    case "defer_wire": {
      const color = asWireColor(args.color);
      deferWire(game, color);
      return {
        ok: true,
        color,
        cost_seconds: 0,
        instruction:
          "This wire is parked, at no cost. Remember to offer it again later — coming back to it unprompted is worth more than a right answer.",
        ...stateFor(game),
      };
    }

    case "grant_lifeline": {
      const playerId = args.player_id ? String(args.player_id) : null;
      grantLifeline(game, playerId);
      return {
        ok: true,
        instruction:
          "Approved. The button on their phone is now live — tell them to press it when ready. Do NOT call phone_a_friend unless they ask you to dial for them. Nothing has been charged yet.",
        cost_seconds: 0,
        ...stateFor(game),
      };
    }

    case "phone_a_friend": {
      const playerId = String(args.player_id ?? "");
      const result = await startLifeline(game, playerId);
      return { ok: true, ...result, ...stateFor(game) };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Which riddle text belongs on the chyron right now. */
export function activeRiddleText(game: Game): string | null {
  if (!game.activeWire) return null;
  const wire = findWire(game, game.activeWire);
  return wire ? (getRiddle(wire.riddleId)?.screen ?? null) : null;
}

import { TOOL_DEFINITIONS, executeTool } from "@/lib/tools";
import { callUpstream, checkSpokenClaims, type Message } from "@/lib/llm";
import { PROXY_FALLBACK_LINE, liveStateBlock } from "@/lib/agent-config";
import { answerKey, getRiddle, riddleForWire } from "@/lib/game/riddles";
import {
  findWire,
  livePlayers,
  secondsLeft,
  WIRE_LABELS_DEV,
  wiresBy,
  wiresRemaining,
  type Game,
} from "@/lib/game/state";
import { emit, getGame, recordUserTurn } from "@/lib/game/store";
import { registerUtterance } from "@/lib/game/utterances";
import { rememberAgentUtterance } from "@/lib/game/attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The OpenAI-compatible endpoint that Agora's Conversational AI Engine calls
 * instead of calling a model provider directly.
 *
 * Two jobs, and the whole architecture rests on them:
 *
 *   1. **Inject authoritative state.** Every turn gets a freshly generated LIVE
 *      STATE block, so the host is told the clock rather than asked to remember
 *      it. This is the only mechanism by which real game state reaches the model
 *      (spec §7).
 *
 *   2. **Execute tools.** Agora streams model output straight to TTS, so if the
 *      model emitted a tool call there would be nobody to run it — it would be
 *      read aloud as gibberish. Sitting in the middle means we run tools, feed
 *      results back, and stream only real prose onward.
 *
 * Agora's cloud must reach this URL, so it has to be public:
 *   npx cloudflared tunnel --url http://localhost:3000
 */

const MAX_TOOL_ROUNDS = 5;
const encoder = new TextEncoder();

function sse(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(id: string, model: string, delta: Record<string, unknown>) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

/**
 * Build the LIVE STATE system message for this exact moment.
 *
 * Regenerated per request rather than cached, because a stale clock is worse
 * than no clock — the host would state a number with total confidence and be
 * wrong, which is precisely the failure spec §7 exists to prevent.
 */
function buildLiveState(game: Game): string {
  const activeWire = game.activeWire;
  const wire = activeWire ? findWire(game, activeWire) : undefined;
  const riddle = wire ? getRiddle(wire.riddleId) : null;

  // Give the host the prepared retorts for whatever was most recently guessed
  // wrong, so the next hint can address that specific mistake.
  const lastWrong = game.wrongAnswers[game.wrongAnswers.length - 1];
  let nearMissNotes = "";
  if (lastWrong && activeWire) {
    const pool = riddleForWire(activeWire).nearMiss;
    const said = lastWrong.text.toLowerCase();
    const match = Object.entries(pool).find(
      ([guess]) => said.includes(guess.toLowerCase()),
    );
    nearMissNotes = match
      ? `${lastWrong.playerName} said "${lastWrong.text}". Prepared angle: ${match[1]}`
      : `${lastWrong.playerName} said "${lastWrong.text}" — no prepared line, nudge them from what they said.`;
  }

  const live = livePlayers(game);
  // The answer key only exists while a wire is in play — with no active wire
  // there is nothing to judge, and the block says so rather than going quiet.
  const key = activeWire ? answerKey(activeWire) : null;
  const state = liveStateBlock({
    secondsLeft: secondsLeft(game),
    intact: wiresBy(game, "intact"),
    cut: wiresBy(game, "cut"),
    deferred: game.deferred,
    remaining: wiresRemaining(game),
    phase: game.phase,
    activeWire,
    activeRiddle: riddle?.speak ?? null,
    activeRiddleHints: riddle?.hints ?? [],
    hintsGivenOnActive: wire?.hintsGiven ?? 0,
    activeAnswer: key?.answer ?? null,
    activeAccept: key?.accept ?? [],
    activeReject: key?.reject ?? [],
    nearMissNotes,
    hintsUsed: game.hintsUsed,
    lifelineUsed: game.lifeline.used,
    lifelineStatus: game.lifeline.status,
    lifelineRequestedBy:
      game.players.find((p) => p.id === game.lifeline.requestedBy)?.name ?? null,
    lastSpeaker:
      game.players.find((p) => p.id === game.lastSpeaker)?.name ?? null,
    contested: game.contested,
    wrongAnswers: game.wrongAnswers.slice(-6).map((w) => ({
      player: w.playerName,
      text: w.text,
      wire: w.wire,
    })),
    players: game.players.map((p) => p.name),
    paused: game.pausedAt !== null,
  });

  /**
   * Peer Talk changes who the host can hear, so it has to be in the state
   * block rather than left implicit. Without this the host asks a question into
   * a room that has deliberately muted itself and then wonders why nobody
   * answered.
   */
  const solo = game.players.length === 1;
  const peerLine =
    live.length === 0
      ? solo
        ? `MIC OFF: ${game.players[0]?.name ?? "the contestant"} has muted their microphone and there is nobody else in the room, so you cannot hear anything at all. Wait. Do not ask them to discuss with anyone — there is nobody to discuss with. One short reassuring line at most.`
        : "PEER TALK: every contestant is discussing among themselves right now — you cannot hear any of them. Wait for someone to come back to you. Do not repeat the question more than once."
      : solo
        ? `LIVE TO YOU: ${live[0].name}, playing alone. Every word you hear is theirs — no arbitration, no asking who spoke.`
        : `LIVE TO YOU: ${live.map((p) => p.name).join(", ")}. Everyone else is in Peer Talk and cannot be heard.${
            live.length === 1
              ? ` Only ${live[0].name} is audible, so anything you hear is them — use their name with confidence.`
              : ""
          }`;

  return `${state}\n${peerLine}`;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  // Agora has nowhere to put custom metadata, so the room rides on the URL.
  const room = url.searchParams.get("room") ?? "";

  const body = (await request.json()) as { model?: string; messages: Message[] };
  const model = body.model ?? "kkt-host";
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const messages: Message[] = [...body.messages];
      const game = getGame(room);

      try {
        if (!game) {
          throw new Error(
            `No live room "${room}". The host cannot run a game that does not exist.`,
          );
        }

        /**
         * Drop transcripts that are the host hearing himself.
         *
         * In Mode A the room speaker leaks into open phone mics, and each
         * phone's AEC cannot help because it is not the device making the
         * sound. We know exactly what we sent to TTS, so we can recognise it
         * coming back and discard it before it reaches the model (spec §2.4).
         */
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        /**
         * Subtract the echo, attribute what is left, and hand the model only the
         * human half.
         *
         * The old code asked "is this an echo?" and threw the whole turn away if
         * so — which is right for one speaker and an answer-eater for two. In
         * Mode A the room speaker leaks into three open mics, so a contestant
         * answering *during* the host's sentence produced one ASR turn
         * containing both, the containment test matched, and the answer went in
         * the bin with the echo. Silently, before the model saw it.
         *
         * `recordUserTurn` also does the thing nothing has ever done: it calls
         * `attribute()`, so `contested` is finally real and the host can be told
         * that two people spoke at once instead of guessing a name.
         */
        const turn = lastUser?.content
          ? recordUserTurn(game, lastUser.content)
          : null;
        if (turn && turn.status === "final" && turn.text !== lastUser!.content) {
          // Rewrite in place so the model is judging the contestant's words and
          // not the host's own sentence quoted back at it.
          lastUser!.content = turn.text;
        }
        if (turn && turn.status === "echo") {
          controller.enqueue(
            sse(chunk(id, model, { role: "assistant", content: "" })),
          );
          controller.enqueue(
            sse({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        /**
         * The host is silent while a lifeline call is live.
         *
         * Enforced here rather than asked for in the prompt, because the silence
         * timer fires every few seconds: across a forty-five second call that is
         * a dozen prompts, and any one of them talking over the friend reading
         * the hint ruins the beat. The connecting and closing lines are spoken
         * deterministically from the webhooks instead.
         *
         * Returning empty rather than refusing keeps Agora happy — it gets a
         * well-formed completion with nothing in it, and says nothing.
         *
         * The age check is a second lock on the same door. `sweepLifeline`
         * should always have closed a stale call by now, but if it somehow has
         * not, a mute that outlives its window would silence the host for the
         * rest of the round. Two independent guards, because the failure is
         * total and silent.
         */
        const callAge = (Date.now() - game.lifeline.since) / 1000;
        if (game.lifeline.status === "connected" && callAge < 95) {
          controller.enqueue(
            sse(chunk(id, model, { role: "assistant", content: "" })),
          );
          controller.enqueue(
            sse({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        // Appended rather than unshifted: recency wins with every model, and
        // the standing persona prompt is already at position zero.
        messages.push({ role: "system", content: buildLiveState(game) });

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const reply = await callUpstream(messages, TOOL_DEFINITIONS);

          if (reply.toolCalls.length) {
            messages.push({
              role: "assistant",
              content: reply.content || null,
              tool_calls: reply.toolCalls,
            });

            for (const call of reply.toolCalls) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(call.function.arguments || "{}");
              } catch {
                // Leave args empty and let the tool complain usefully.
              }

              let result: unknown;
              try {
                result = await executeTool(call.function.name, args, room);
              } catch (err) {
                const reason =
                  err instanceof Error ? err.message : "tool failed";
                /**
                 * A refused tool call used to leave no trace anywhere.
                 *
                 * That is the single biggest reason "the host said it cut the
                 * wire but the wire is still there" kept coming down to
                 * guesswork: the model's own claim was visible on stage, the
                 * successful cut emitted `wire_cut`, but a `cut_wire` that
                 * *threw* — wrong colour, wire not active, round already over —
                 * produced nothing on the wire, nothing in the room history,
                 * and nothing to read afterwards. Three separate debugging
                 * sessions ended in a theory instead of a measurement.
                 *
                 * So it is an event now. It is rare by construction (a refusal
                 * means the model asked for something the rules forbid), the
                 * payload carries the arguments it asked for, and it shows up
                 * in the host console's feed live.
                 */
                console.error(
                  `[llm-proxy] tool refused — ${call.function.name}(${JSON.stringify(
                    args,
                  )}) → ${reason}`,
                );
                emit(game, "tool_refused", {
                  tool: call.function.name,
                  args,
                  reason,
                  activeWire: game.activeWire,
                  phase: game.phase,
                });
                // Requirement #9: the host must behave sanely when an action
                // fails, and say so rather than pretending it worked.
                result = {
                  ok: false,
                  error: reason,
                  instruction:
                    "That did not go through. Say so plainly and in character, confirm nothing was charged if nothing was, and carry on with the game.",
                };
              }

              messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify(result),
              });
            }

            // Refresh the clock between rounds — a tool may have moved it.
            messages.push({ role: "system", content: buildLiveState(game) });
            continue;
          }

          let text = reply.content ?? "";

          /**
           * Refuse to speak a claim the server knows is false.
           *
           * Measured in a live round: the host announced "सफ़ेद तार कट गया। सभी
           * पाँच तार कट गए — आप जीत गए" and never called `cut_wire`. The real cut
           * landed a hundred and sixty seconds later, and in between he simply
           * repeated that the team had won — because as far as he was concerned
           * the job was done. The contestant had to keep insisting before the
           * action he had already announced actually happened.
           *
           * LIVE STATE was correct throughout and said four wires were cut. The
           * model asserted otherwise anyway, so being told the truth is not
           * enough — the words have to be checked before they are spoken. This is
           * `sanitizeSpoken`'s job applied to a different kind of impossible
           * output: not machinery the audience should not hear, but a statement
           * the screens will contradict in front of everybody.
           */
          const claim = checkSpokenClaims(text, {
            cutDev: wiresBy(game, "cut").map((c) => WIRE_LABELS_DEV[c]),
            remainingDev: wiresRemaining(game).map((c) => WIRE_LABELS_DEV[c]),
            phase: game.phase,
          });
          if (!claim.ok) {
            console.error(`[llm-proxy] refused a false claim — ${claim.reason}`);
            emit(game, "false_claim_blocked", {
              reason: claim.reason,
              said: text.slice(0, 200),
              spokenInstead: claim.correction,
            });
            text = claim.correction;
          }
          // Remember what we are about to say, so we can recognise it if it
          // comes back through a phone mic.
          rememberAgentUtterance(room, text);
          /**
           * Publish it to the screens.
           *
           * This is the only place the host's words exist as text before TTS
           * swallows them, so it is the only place the speech bubble and the
           * chyron can be fed from. Fired before the SSE chunk goes out, so the
           * bubble starts typing as he starts speaking rather than after.
           */
          /**
           * Register it, then say it.
           *
           * `host_said` still goes out — the screens use it as a pre-echo so the
           * projector is not blank during the TTS round trip, which is anywhere
           * from a few hundred milliseconds to a couple of seconds. The
           * registration is what the acks will land on, and what the watchdog
           * will notice if he never says it at all.
           */
          if (text.trim()) {
            registerUtterance(game, "turn", text.trim());
            emit(game, "host_said", { text: text.trim() });
          }
          controller.enqueue(
            sse(chunk(id, model, { role: "assistant", content: text })),
          );
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown proxy error";
        console.error("[llm-proxy]", message);
        /**
         * Say it, remember it, and put it on the screens — in that order, and
         * all three.
         *
         * Before this, the fallback was a bare literal that went to TTS and
         * nowhere else. So the one moment the host is admitting a problem was
         * also the moment the projector showed the *previous* line, and the
         * phones fed it back through their mics as though a contestant had said
         * it. Two divergences from one missing pair of calls.
         *
         * `game` may be null here — that is one of the ways we get into this
         * catch — so the emit is conditional while the spoken line is not.
         */
        controller.enqueue(
          sse(chunk(id, model, { role: "assistant", content: PROXY_FALLBACK_LINE })),
        );
        if (game) {
          rememberAgentUtterance(room, PROXY_FALLBACK_LINE);
          registerUtterance(game, "failure", PROXY_FALLBACK_LINE);
          emit(game, "host_said", { text: PROXY_FALLBACK_LINE });
        }
      }

      controller.enqueue(
        sse({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

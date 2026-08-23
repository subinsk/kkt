import { TOOL_DEFINITIONS, executeTool } from "@/lib/tools";
import { callUpstream, type Message } from "@/lib/llm";
import { liveStateBlock } from "@/lib/agent-config";
import { getRiddle, riddleForWire } from "@/lib/game/riddles";
import {
  findWire,
  livePlayers,
  secondsLeft,
  wiresBy,
  type Game,
} from "@/lib/game/state";
import { getGame } from "@/lib/game/store";
import { isSelfEcho, rememberAgentUtterance } from "@/lib/game/attribution";

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
  const state = liveStateBlock({
    secondsLeft: secondsLeft(game),
    intact: wiresBy(game, "intact"),
    cut: wiresBy(game, "cut"),
    deferred: game.deferred,
    activeWire,
    activeRiddle: riddle?.speak ?? null,
    activeRiddleHints: riddle?.hints ?? [],
    hintsGivenOnActive: wire?.hintsGiven ?? 0,
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
  const peerLine =
    live.length === 0
      ? "PEER TALK: every contestant is discussing among themselves right now — you cannot hear any of them. Wait for someone to come back to you. Do not repeat the question more than once."
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
        if (lastUser?.content && isSelfEcho(room, lastUser.content)) {
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
                // Requirement #9: the host must behave sanely when an action
                // fails, and say so rather than pretending it worked.
                result = {
                  ok: false,
                  error: err instanceof Error ? err.message : "tool failed",
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

          const text = reply.content ?? "";
          // Remember what we are about to say, so we can recognise it if it
          // comes back through a phone mic.
          rememberAgentUtterance(room, text);
          controller.enqueue(
            sse(chunk(id, model, { role: "assistant", content: text })),
          );
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown proxy error";
        console.error("[llm-proxy]", message);
        controller.enqueue(
          sse(
            chunk(id, model, {
              role: "assistant",
              content: "Ek minute... thodi technical dikkat hai. Phir se boliye?",
            }),
          ),
        );
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

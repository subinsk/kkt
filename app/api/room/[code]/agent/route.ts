import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { APP_CERTIFICATE, appId } from "@/lib/env";
import {
  agentIsGone,
  agentStatus,
  agoraFetch,
  buildAgentProperties,
  interruptAgent,
  speak,
} from "@/lib/agora-rest";
import { AGENT_NAME, SYSTEM_PROMPT, openingLine } from "@/lib/agent-config";
import { agentUidFor, emit, getGame, openRound } from "@/lib/game/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The host's lifecycle — start, stop, interrupt, and speak an exact line.
 *
 * Tracked in module scope so /interrupt and /speak can find the running agent
 * later without the caller having to remember an id. There is one host per room
 * and rooms live for minutes, so a Map is the right amount of machinery.
 */
const globalAgents = globalThis as unknown as {
  __kktAgents?: Map<string, string>;
};
const agents: Map<string, string> = (globalAgents.__kktAgents ??= new Map());

export function agentIdFor(code: string): string | undefined {
  return agents.get(code.toUpperCase());
}

/**
 * Has the agent we remember actually left the room?
 *
 * The map is a memory, not a fact. An agent can exit on its own — idle timeout,
 * a crash, an Agora-side reap — and nothing tells us. Before this check, the
 * stale id made `start` return `alreadyRunning` forever and the host never came
 * back: the projector said everything was fine and the room sat in silence. The
 * only way out was restarting the dev server, which is not a thing you can do
 * with judges watching.
 *
 * Deliberately conservative: only a definite "gone" counts. If Agora is
 * unreachable or answers something unexpected we assume the agent is alive,
 * because a duplicate host talking over itself is worse on stage than a Kill
 * button the operator has to press once.
 */
async function hasLeft(agentId: string): Promise<boolean> {
  try {
    const { status } = await agentStatus(agentId);
    // Docs pair the names with numbers — IDLE 0, STARTING 1, RUNNING 2,
    // STOPPING 3, STOPPED 4, FAILED 6 — and do not promise which form the JSON
    // carries, so accept either.
    const state = String(status).toUpperCase();
    const live = ["RUNNING", "STARTING", "1", "2"];
    return !live.includes(state);
  } catch (error) {
    return agentIsGone(error);
  }
}

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/room/[code]/agent">,
) {
  const { code } = await ctx.params;
  return NextResponse.json({ agentId: agents.get(code.toUpperCase()) ?? null });
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/agent">,
) {
  try {
    const { code } = await ctx.params;
    const game = getGame(code);
    if (!game) {
      return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: "start" | "stop" | "interrupt" | "speak";
      text?: string;
      interruptable?: boolean;
    };
    const action = body.action ?? "start";
    const existing = agents.get(game.code);

    /* -- start ---------------------------------------------------------- */

    if (action === "start") {
      if (existing) {
        if (!(await hasLeft(existing))) {
          return NextResponse.json({ agentId: existing, alreadyRunning: true });
        }
        // It is gone. Forget it and join a fresh one, rather than reporting a
        // host that is not there.
        agents.delete(game.code);
        emit(game, "agent_reaped", { agentId: existing });
      }

      /**
       * Choose the opening wire before the host says a word.
       *
       * The greeting is TTS'd verbatim with no LLM turn behind it, so the first
       * riddle can only be in it if the wire is already picked. Doing it here —
       * rather than after the clock starts — is what lets the round open on a
       * question instead of on "toh bataiye, kis taar se shuru karein?".
       */
      const opening = openRound(game);
      /**
       * A greeting that promises a question and then does not ask one is dead
       * air with no error anywhere — the exact failure mode this project keeps
       * turning into a loud one. So refuse to join instead.
       */
      if (!opening?.riddle?.speak) {
        return NextResponse.json(
          {
            error:
              "No riddle available for the opening wire — cannot open the round.",
          },
          { status: 500 },
        );
      }

      const agentUid = agentUidFor(game.code);
      const expireAt = Math.floor(Date.now() / 1000) + 3600;
      const agentToken = RtcTokenBuilder.buildTokenWithUid(
        appId(),
        APP_CERTIFICATE(),
        game.code,
        agentUid,
        RtcRole.PUBLISHER,
        expireAt,
        expireAt,
      );

      const greeting = openingLine({
        players: game.players.map((p) => p.name),
        wire: opening.wire.color,
        riddle: opening.riddle.speak,
      });

      const result = await agoraFetch<{ agent_id: string; status: string }>(
        "/join",
        {
          method: "POST",
          body: {
            // Unique per project — collisions return 409. Scoping to the room
            // plus a short suffix means a restart after a crash does not clash
            // with an agent Agora has not finished reaping.
            name: `${AGENT_NAME}-${game.code}-${Date.now().toString(36).slice(-4)}`,
            properties: buildAgentProperties({
              channel: game.code,
              token: agentToken,
              agentUid: String(agentUid),
              systemPrompt: SYSTEM_PROMPT,
              greeting,
            }),
          },
        },
      );

      agents.set(game.code, result.agent_id);
      emit(game, "agent_started", { agentId: result.agent_id, agentUid });

      /**
       * Put the opening on the screens too.
       *
       * The greeting is the one thing the host says that never passes through
       * the LLM proxy — Agora TTSs `greeting_message` directly — so it is also
       * the one thing `host_said` never fired for. The result was the longest
       * line of the whole game, the one carrying the rules, playing with a blank
       * speech bubble above his head.
       *
       * Emitting it here is safe *because* the bubble waits for audio: this
       * fires the moment Agora accepts the join, seconds before he actually
       * starts talking, and the screens sit on it until they hear him.
       */
      emit(game, "host_said", { text: greeting });

      return NextResponse.json({
        agentId: result.agent_id,
        agentUid,
        status: result.status,
      });
    }

    /* -- everything else needs a running agent -------------------------- */

    if (!existing) {
      return NextResponse.json(
        { error: "No agent is running in this room." },
        { status: 409 },
      );
    }

    if (action === "stop") {
      /**
       * Stop means "there is no host in this room afterwards".
       *
       * If Agora says the session is already gone, that goal is met — so drop
       * the id and report success instead of an error. Before this, a 404 left
       * the dead id in the map with no way to clear it, which turned Kill into
       * a button that permanently broke Start.
       */
      try {
        await agoraFetch(`/agents/${existing}/leave`, { method: "POST" });
      } catch (error) {
        if (!agentIsGone(error)) throw error;
        agents.delete(game.code);
        emit(game, "agent_reaped", { agentId: existing });
        return NextResponse.json({ stopped: true, alreadyGone: true });
      }
      agents.delete(game.code);
      emit(game, "agent_stopped", { agentId: existing });
      return NextResponse.json({ stopped: true });
    }

    if (action === "interrupt") {
      await interruptAgent(existing);
      return NextResponse.json({ interrupted: true });
    }

    if (action === "speak") {
      const text = (body.text ?? "").trim();
      if (!text) {
        return NextResponse.json({ error: "text is required" }, { status: 400 });
      }
      // `interruptable: false` for the lines that must land — the closing beat
      // after the outcome stinger, with a room that is cheering.
      await speak(existing, text, { interruptable: body.interruptable ?? true });
      emit(game, "agent_spoke", { text });
      return NextResponse.json({ spoken: true });
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

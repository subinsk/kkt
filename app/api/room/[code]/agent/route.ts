import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { APP_CERTIFICATE, appId } from "@/lib/env";
import {
  agoraFetch,
  buildAgentProperties,
  interruptAgent,
  speak,
} from "@/lib/agora-rest";
import { AGENT_NAME, SYSTEM_PROMPT, greetingFor } from "@/lib/agent-config";
import { agentUidFor, emit, getGame } from "@/lib/game/store";

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
        return NextResponse.json({ agentId: existing, alreadyRunning: true });
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
              greeting: greetingFor(game.players.map((p) => p.name)),
            }),
          },
        },
      );

      agents.set(game.code, result.agent_id);
      emit(game, "agent_started", { agentId: result.agent_id, agentUid });

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
      await agoraFetch(`/agents/${existing}/leave`, { method: "POST" });
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

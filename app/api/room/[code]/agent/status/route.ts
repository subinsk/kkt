import { NextResponse } from "next/server";
import { agentStatus } from "@/lib/agora-rest";
import { agentIdFor } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Agora thinks of our agent, as opposed to what we remember about it.
 *
 * Our own map holds an id from the moment `/join` returns 200 — which proves the
 * request was accepted, not that the agent is alive. The two diverge in the worst
 * way: an agent that failed after joining leaves a healthy-looking id behind, so
 * every screen reports fine while the room sits in silence. `hasLeft()` already
 * consults this before restarting; this exposes it so a pre-flight check and a
 * human at a rehearsal can ask the same question.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/room/[code]/agent/status">,
) {
  const { code } = await ctx.params;
  const agentId = agentIdFor(code);
  if (!agentId) return NextResponse.json({ agentId: null, status: "none" });
  try {
    const { status, start_ts } = await agentStatus(agentId);
    return NextResponse.json({ agentId, status, start_ts });
  } catch (error) {
    return NextResponse.json({
      agentId,
      status: "unreachable",
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

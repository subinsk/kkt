import { NextResponse } from "next/server";
import { agoraFetch } from "@/lib/agora-rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stops a running agent. Always call this when the user hangs up — idle_timeout
 * is a safety net, not a lifecycle.
 * POST /api/agent/stop  { agentId }
 */
export async function POST(request: Request) {
  try {
    const { agentId } = (await request.json()) as { agentId?: string };
    if (!agentId) {
      return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    }

    await agoraFetch(`/agents/${agentId}/leave`, { method: "POST" });
    return NextResponse.json({ stopped: true, agentId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

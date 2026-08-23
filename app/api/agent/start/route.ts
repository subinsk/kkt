import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { agoraFetch, buildAgentProperties } from "@/lib/agora-rest";
import { AGENT_NAME, GREETING, SYSTEM_PROMPT } from "@/lib/agent-config";
import { APP_CERTIFICATE, APP_ID } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_UID = 1001;

type StartResponse = { agent_id: string; create_ts: number; status: string };

/**
 * Drops a Conversational AI agent into an existing RTC channel.
 * POST /api/agent/start  { channel, uid }
 */
export async function POST(request: Request) {
  try {
    const { channel, uid } = (await request.json()) as {
      channel?: string;
      uid?: number;
    };

    if (!channel || typeof uid !== "number") {
      return NextResponse.json(
        { error: "channel (string) and uid (number) are required" },
        { status: 400 },
      );
    }

    // The agent needs its own token, minted for its own uid in the same channel.
    const expireAt = Math.floor(Date.now() / 1000) + 3600;
    const agentToken = RtcTokenBuilder.buildTokenWithUid(
      APP_ID(),
      APP_CERTIFICATE(),
      channel,
      AGENT_UID,
      RtcRole.PUBLISHER,
      expireAt,
      expireAt,
    );

    // `name` must be unique per running agent, so scope it to the channel.
    const result = await agoraFetch<StartResponse>("/join", {
      method: "POST",
      body: {
        name: `${AGENT_NAME}-${channel}`,
        properties: buildAgentProperties({
          channel,
          token: agentToken,
          agentUid: String(AGENT_UID),
          systemPrompt: SYSTEM_PROMPT,
          greeting: GREETING,
        }),
      },
    });

    return NextResponse.json({ ...result, agentUid: AGENT_UID });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

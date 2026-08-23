import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { APP_CERTIFICATE, APP_ID } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_TTL_SECONDS = 3600;

/**
 * Mints an RTC token for a channel/uid pair.
 * GET /api/agora/token?channel=demo&uid=1002
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const channel = searchParams.get("channel");
    const uid = Number(searchParams.get("uid") ?? 0);

    if (!channel) {
      return NextResponse.json({ error: "channel is required" }, { status: 400 });
    }
    if (!Number.isInteger(uid) || uid < 0) {
      return NextResponse.json({ error: "uid must be a non-negative integer" }, { status: 400 });
    }

    const expireAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID(),
      APP_CERTIFICATE(),
      channel,
      uid,
      RtcRole.PUBLISHER,
      expireAt,
      expireAt,
    );

    return NextResponse.json({ token, uid, channel, expireAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

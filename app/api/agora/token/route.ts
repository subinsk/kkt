import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtmTokenBuilder, RtcRole } from "agora-token";
import { APP_CERTIFICATE, APP_ID } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_TTL_SECONDS = 3600;

/**
 * Mints the tokens a client needs for one seat.
 * GET /api/agora/token?channel=demo&uid=1002
 *
 * Two tokens, not one. RTC carries the audio; RTM carries the agent's own
 * transcript — which is the only authoritative answer to "what did the host
 * actually say", and therefore the only thing the speech bubble can honestly be
 * driven from. Agora publishes it to the RTM channel of the same name because
 * `buildAgentProperties` sets `enable_rtm` and `data_channel: "rtm"`; without an
 * RTM login on this side, it is published to a channel nobody is on.
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

    /**
     * The RTM token's subject must be the string form of the RTC uid.
     *
     * Not cosmetic. If the token is minted for one identity and the client logs
     * in as another, Agora reports it as a generic failure to start rather than
     * as an auth error — so it reads like the transcript feature being broken
     * rather than like a mismatched id. `lib/rtm.ts` logs in with
     * `String(credentials.uid)`, and this is the other end of that agreement.
     *
     * Note the different unit: `RtcTokenBuilder` takes absolute expiry
     * timestamps, `RtmTokenBuilder.buildToken` takes a number of seconds from
     * now. Passing an absolute timestamp here mints a token valid for the next
     * fifty-odd years, which is not a failure you would notice.
     */
    const rtmToken = RtmTokenBuilder.buildToken(
      APP_ID(),
      APP_CERTIFICATE(),
      String(uid),
      TOKEN_TTL_SECONDS,
    );

    return NextResponse.json({ token, rtmToken, uid, channel, expireAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

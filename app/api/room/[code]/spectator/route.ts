import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { APP_CERTIFICATE, appId } from "@/lib/env";
import { agentUidFor, getGame } from "@/lib/game/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/room/DEMO/spectator — credentials for the projector.
 *
 * The projector subscribes but never publishes, so it is minted as a SUBSCRIBER.
 * That is not cosmetic: a spectator that could publish is a spectator that can
 * accidentally open a mic into a room that already has three of them.
 *
 * A random uid per tab, so opening the projector view twice (which happens —
 * one on the laptop, one for a judge on a phone) does not kick the first one out
 * of the channel.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/room/[code]/spectator">,
) {
  const { code } = await ctx.params;
  const game = getGame(code);
  if (!game) {
    return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
  }

  const uid = 900000 + Math.floor(Math.random() * 90000);
  const expireAt = Math.floor(Date.now() / 1000) + 3600;

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId(),
    APP_CERTIFICATE(),
    game.code,
    uid,
    RtcRole.SUBSCRIBER,
    expireAt,
    expireAt,
  );

  return NextResponse.json({
    appId: appId(),
    channel: game.code,
    uid,
    token,
    agentUid: agentUidFor(game.code),
  });
}

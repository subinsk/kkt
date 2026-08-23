import { NextResponse } from "next/server";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { APP_CERTIFICATE, appId } from "@/lib/env";
import {
  addPlayer,
  agentUidFor,
  createGame,
  getGame,
  publicView,
} from "@/lib/game/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_TTL_SECONDS = 3600;

/**
 * POST /api/room/DEMO/join — take a seat.
 *
 * Returns everything the phone needs in one round trip: its identity, its RTC
 * credentials, and the agent's uid so the client can tell the host's audio
 * track apart from the other contestants' (which is what the playback policy in
 * spec §2.3 keys off).
 *
 * Doing this in one call rather than three matters more than it looks: a
 * contestant is standing in a room holding a phone they just pointed at a QR
 * code, and every extra round trip is another chance to be staring at a spinner
 * while the host is already talking.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/join">,
) {
  try {
    const { code } = await ctx.params;
    /**
     * Open the room if it does not exist yet.
     *
     * A contestant reaches this by pointing a camera at a QR code. If the
     * projector has been reloaded — or somebody scans before it is up — a 404
     * here is a dead end they cannot do anything about, in front of an audience.
     * Creating the room is harmless and always the more useful answer.
     */
    const game = getGame(code) ?? createGame({ code });

    const body = (await request.json()) as {
      name?: string;
      phone?: string;
      consent?: boolean;
    };

    const name = (body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Normalise to E.164 for Vobiz. Indian mobiles are entered ten digits far
    // more often than not, so assume +91 when that is what we were handed.
    let phoneE164: string | null = null;
    if (body.consent && body.phone) {
      const digits = body.phone.replace(/\D/g, "");
      if (digits.length === 10) phoneE164 = `+91${digits}`;
      else if (digits.length > 10) phoneE164 = `+${digits}`;
    }

    const player = addPlayer(game, {
      name,
      phoneE164,
      consent: Boolean(body.consent),
    });

    const expireAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId(),
      APP_CERTIFICATE(),
      game.code,
      player.uid,
      RtcRole.PUBLISHER,
      expireAt,
      expireAt,
    );

    return NextResponse.json({
      player: {
        id: player.id,
        uid: player.uid,
        name: player.name,
        seat: player.seat,
        peerMode: player.peerMode,
        hasPhone: player.phoneE164 !== null,
      },
      rtc: {
        appId: appId(),
        channel: game.code,
        uid: player.uid,
        token,
        agentUid: agentUidFor(game.code),
      },
      game: publicView(game),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

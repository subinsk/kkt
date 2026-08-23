import { NextResponse } from "next/server";
import { createGame, getGame, listGames, publicView } from "@/lib/game/store";
import { DEFAULT_DURATION_SECONDS } from "@/lib/game/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/room — every live room, for the host console. */
export async function GET() {
  return NextResponse.json({
    rooms: listGames().map((game) => publicView(game)),
  });
}

/**
 * POST /api/room — open a room.
 *
 * The projector calls this, gets a four-character code, and renders it as a QR.
 * Contestants scan it, so the code exists mainly so it can also be read aloud
 * when a camera will not focus.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      durationSeconds?: number;
    };

    // Reusing an existing code is allowed and useful: it means a projector
    // reload does not orphan three contestants who already joined.
    if (body.code) {
      const existing = getGame(body.code);
      if (existing) {
        return NextResponse.json({ ...publicView(existing), reused: true });
      }
    }

    const duration = Number(body.durationSeconds) || DEFAULT_DURATION_SECONDS;
    const game = createGame({
      code: body.code,
      durationSeconds: Math.min(Math.max(duration, 60), 1800),
    });

    return NextResponse.json({ ...publicView(game), reused: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

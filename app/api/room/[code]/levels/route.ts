import { NextResponse } from "next/server";
import { getGame } from "@/lib/game/store";
import { recordLevels, type LevelSample } from "@/lib/game/attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/room/DEMO/levels — mic-level telemetry from one phone.
 *
 * Batched, not per-sample. The phone measures at ~30Hz as the spec describes
 * but POSTs every 200ms with the handful of samples collected since the last
 * send. Thirty requests a second per handset was never necessary: attribution
 * integrates the level over an utterance window, so it cares about the area
 * under the curve and not at all about how the samples arrived.
 *
 * Kept as its own route, away from /action, because it is the only
 * high-frequency endpoint in the project and it should stay small enough to
 * read at a glance.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/levels">,
) {
  try {
    const { code } = await ctx.params;
    const game = getGame(code);
    if (!game) {
      return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
    }

    const body = (await request.json()) as {
      playerId?: string;
      samples?: LevelSample[];
    };

    if (!body.playerId || !Array.isArray(body.samples)) {
      return NextResponse.json(
        { error: "playerId and samples[] required" },
        { status: 400 },
      );
    }

    recordLevels(
      game.code,
      body.playerId,
      body.samples
        .filter((s) => typeof s.level === "number" && typeof s.t === "number")
        // A phone with a wrong clock would otherwise poison the timeline.
        .map((s) => ({ t: s.t, level: Math.max(0, Math.min(1, s.level)) })),
    );

    // Intentionally no body: this fires five times a second per handset and
    // nobody reads the response.
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}

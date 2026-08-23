import { NextResponse } from "next/server";
import {
  checkTimeout,
  getGame,
  publicView,
  sweepLifeline,
} from "@/lib/game/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/room/DEMO — the public view of a room. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/room/[code]">,
) {
  const { code } = await ctx.params;
  const game = getGame(code);
  if (!game) {
    return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
  }
  // Reading is a fine moment to notice the clock ran out, or that a call was
  // never closed by a webhook.
  sweepLifeline(game);
  checkTimeout(game);
  return NextResponse.json(publicView(game));
}

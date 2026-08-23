import { NextResponse } from "next/server";
import { getGame } from "@/lib/game/store";
import { riddleForWire } from "@/lib/game/riddles";
import { WIRE_COLORS, findWire, type WireColor } from "@/lib/game/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/room/DEMO/riddle?wire=blue — the riddle text for a wire.
 *
 * Returns only the Roman form and how many hints are left. Deliberately not the
 * accept list, the near-miss map, or the hint text: the contestants' own phones
 * are the last place the answers should be sitting, and a curious judge with
 * devtools open is a realistic thing to design against.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/riddle">,
) {
  const { code } = await ctx.params;
  const game = getGame(code);
  if (!game) {
    return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
  }

  const raw = (new URL(request.url).searchParams.get("wire") ?? "").toLowerCase();
  const wire = raw as WireColor;
  if (!WIRE_COLORS.includes(wire)) {
    return NextResponse.json({ error: `Bad wire: ${raw}` }, { status: 400 });
  }

  const riddle = riddleForWire(wire);
  const state = findWire(game, wire);

  return NextResponse.json({
    wire,
    screen: riddle.screen,
    hintsGiven: state?.hintsGiven ?? 0,
    hintsRemaining: Math.max(0, riddle.hints.length - (state?.hintsGiven ?? 0)),
    status: state?.status ?? "intact",
  });
}

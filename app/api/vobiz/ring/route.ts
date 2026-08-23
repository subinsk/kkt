import { NextResponse } from "next/server";
import { attachCallUuid, findCall } from "@/lib/game/lifeline";
import { emit, getGame } from "@/lib/game/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/vobiz/ring?call=LL-… — it is ringing.
 *
 * Costs nothing and changes nothing. It exists so the chyron can say "CALLING…"
 * the instant the handset on the other end starts ringing, rather than after the
 * dial request returns — which makes the two-second gap before a phone rings in
 * the room feel intentional instead of broken.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const callId = url.searchParams.get("call") ?? "";

  const params = await readBody(request);
  const call = findCall(callId);
  if (!call) return NextResponse.json({ ok: true, unknownCall: true });

  const callUuid = params.CallUUID ?? params.call_uuid;
  if (callUuid) attachCallUuid(callId, callUuid);

  const game = getGame(call.room);
  if (game) {
    game.lifeline.status = "ringing";
    emit(game, "lifeline_ringing", { callId, playerId: call.playerId });
  }

  return NextResponse.json({ ok: true });
}

async function readBody(request: Request): Promise<Record<string, string>> {
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      return (await request.json()) as Record<string, string>;
    }
    const form = await request.formData();
    return Object.fromEntries(
      [...form.entries()].map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}

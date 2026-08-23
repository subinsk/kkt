import { XML_HEADERS, hintLoopXml, simpleSpeakXml } from "@/lib/vobiz";
import { attachCallUuid, findCall } from "@/lib/game/lifeline";
import { getGame, lifelineAnswered } from "@/lib/game/store";
import { hintAudioPath } from "@/lib/game/riddles";
import { publicBaseUrl } from "@/lib/env";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WireColor } from "@/lib/game/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/vobiz/answer?call=LL-… — the friend picked up.
 *
 * **This is where the 45 seconds gets charged, and nowhere else.** Vobiz fetches
 * `answer_url` at the moment the callee answers, which makes this the one
 * definitive signal that a human is on the line. Indian mobiles ring for three
 * to eight seconds and charging for ring time feels broken — judges notice.
 *
 * Note what we deliberately do *not* do: branch on a status string. Vobiz's
 * hangup-cause values are not enumerated in the docs (see docs/VOBIZ.md), so
 * instead of matching undocumented strings we use the structural fact that this
 * endpoint is only ever reached on a real answer. The hangup handler then infers
 * failure from the *absence* of this call. That is provable rather than guessed.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const callId = url.searchParams.get("call") ?? "";

  // Vobiz posts form-encoded; tolerate JSON in case that changes.
  const params = await readBody(request);
  const callUuid = params.CallUUID ?? params.call_uuid ?? null;

  const call = findCall(callId);
  if (!call) {
    // Should not happen, but forty-five seconds of silence would be worse.
    return new Response(
      simpleSpeakXml(
        "Sorry, this lifeline has already expired. Thanks for picking up!",
      ),
      { headers: XML_HEADERS },
    );
  }

  if (callUuid) attachCallUuid(callId, callUuid);

  const game = getGame(call.room);
  if (game) {
    // The clock starts now.
    lifelineAnswered(game);
  }

  /**
   * Verify the audio exists before promising it.
   *
   * Vobiz **silently skips** a `Play` it cannot fetch, so a missing MP3 is dead
   * air on a live call with nothing in any log. Since we can check, we check —
   * and if it is missing we say something instead of nothing.
   */
  const relative = hintAudioPath(call.wire as WireColor);
  const onDisk = existsSync(join(process.cwd(), "public", relative));

  if (!onDisk) {
    console.warn(`[vobiz] hint audio missing: public${relative}`);
    return new Response(
      simpleSpeakXml(
        "Sorry, the hint recording could not be loaded. Please tell your friend to ask the host for a hint instead.",
      ),
      { headers: XML_HEADERS },
    );
  }

  const base = publicBaseUrl();
  return new Response(
    hintLoopXml({ audioUrl: `${base}${relative}`, windowSeconds: 45, gapSeconds: 3 }),
    { headers: XML_HEADERS },
  );
}

/** Vobiz posts `application/x-www-form-urlencoded`. */
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

export { readBody };

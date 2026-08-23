import { NextResponse, type NextRequest } from "next/server";
import { isSet, optional, resolvePublicBase } from "@/lib/env";
import { RIDDLES } from "@/lib/game/riddles";
import { listGames } from "@/lib/game/store";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pre-flight check. Run this before every rehearsal.
 *
 * The point is to surface the failures that are otherwise *silent*, because
 * this project has an unusual number of them:
 *
 *   - A stale PUBLIC_BASE_URL (cloudflared restarted) breaks the LLM proxy and
 *     every Vobiz webhook, with no error anywhere.
 *   - A missing hint clip makes Vobiz skip the audio, so Phone a Friend becomes
 *     forty-five seconds of dead air on a live call.
 *   - A missing outcome stinger means the endgame beat just does not happen.
 *
 * None of those announce themselves at runtime. All of them are visible here.
 */
/**
 * Is a clip actually fetchable?
 *
 * On disk first, because that is free and it is the whole story on Render and
 * locally. But on Vercel `public/` is served by the CDN and is *not* on the
 * function's filesystem, so `existsSync` returns false for files that are being
 * served perfectly well. Reporting those as missing would be a false alarm on
 * every single deploy.
 *
 * So when the disk says no, ask over HTTP before believing it — but ask *this*
 * host, never PUBLIC_BASE_URL. Those can be different origins, and a check that
 * probed PUBLIC_BASE_URL would happily report another process's files as proof
 * that this build shipped them. Whether PUBLIC_BASE_URL is the right origin at
 * all is a separate question, answered by the split-brain check below.
 */
async function reachable(localPath: string, url: string): Promise<boolean> {
  if (existsSync(localPath)) return true;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const keys = {
    agora_app_id: isSet("NEXT_PUBLIC_AGORA_APP_ID") || isSet("AGORA_APP_ID"),
    agora_app_certificate: isSet("AGORA_APP_CERTIFICATE"),
    agora_customer_id: isSet("AGORA_CUSTOMER_ID"),
    agora_customer_secret: isSet("AGORA_CUSTOMER_SECRET"),
    sarvam: isSet("SARVAM_API_KEY"),
    llm: isSet("LLM_API_KEY"),
    vobiz_auth_id: isSet("VOBIZ_AUTH_ID"),
    vobiz_auth_token: isSet("VOBIZ_AUTH_TOKEN"),
    vobiz_from_number: isSet("VOBIZ_FROM_NUMBER"),
    public_base_url: Boolean(resolvePublicBase().url),
  };

  // Not read straight from PUBLIC_BASE_URL: on Render and Vercel the host
  // supplies it, so checking only the explicit var would report a blocking
  // failure on a deployment that is in fact fine.
  const { url: publicBase, source: publicBaseSource } = resolvePublicBase();

  /**
   * Whoever actually answered this request, as opposed to whoever the env says
   * we are. The two disagreeing is the whole point of the split-brain check
   * further down.
   */
  const servingHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const servingProto = request.headers.get("x-forwarded-proto") ?? "http";
  const selfOrigin = servingHost ? `${servingProto}://${servingHost}` : "";
  const baseHost = (() => {
    try {
      return new URL(publicBase).host;
    } catch {
      return "";
    }
  })();

  const audioDir = join(process.cwd(), "public", "audio");

  // Verified rather than trusted, because a missing file here is inaudible
  // rather than loud.
  const hintAudio = await Promise.all(
    RIDDLES.map(async (r) => ({
      riddle: r.id,
      file: `/audio/hints/${r.id}_h1.wav`,
      present: await reachable(
        join(audioDir, "hints", `${r.id}_h1.wav`),
        selfOrigin ? `${selfOrigin}/audio/hints/${r.id}_h1.wav` : "",
      ),
    })),
  );

  const outcomeAudio = await Promise.all(
    [
      // The recorded takes the projector actually plays — not the synthesised
      // stand-ins render-hints.ts can produce, which nothing reads any more.
      { name: "win", file: "win.mp3" },
      { name: "lose", file: "lose.mp3" },
    ].map(async (a) => ({
      ...a,
      present: await reachable(
        join(audioDir, "outcome", a.file),
        selfOrigin ? `${selfOrigin}/audio/outcome/${a.file}` : "",
      ),
    })),
  );

  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!keys.agora_app_id) blocking.push("NEXT_PUBLIC_AGORA_APP_ID is not set.");
  if (!keys.agora_app_certificate) {
    blocking.push("AGORA_APP_CERTIFICATE is not set — no client can join.");
  }
  if (!keys.agora_customer_id || !keys.agora_customer_secret) {
    blocking.push("Agora RESTful credentials missing — the agent cannot start.");
  }
  if (!keys.sarvam) blocking.push("SARVAM_API_KEY is not set — no voice at all.");
  if (!keys.llm) blocking.push("LLM_API_KEY is not set — the host cannot think.");
  if (!keys.public_base_url) {
    blocking.push(
      "No public base URL — Agora cannot reach /api/llm. Set PUBLIC_BASE_URL (it is derived automatically on Render and Vercel).",
    );
  } else if (publicBase.includes("localhost") || publicBase.includes("127.0.0.1")) {
    blocking.push(
      "PUBLIC_BASE_URL points at localhost, which is invisible to Agora and Vobiz. Start a tunnel.",
    );
  } else if (/your-tunnel|example\.com|changeme|<.*>/i.test(publicBase)) {
    // The placeholder from .env.example. Worth its own check, because it *looks*
    // like a real URL and would otherwise report ready while nothing can reach us.
    blocking.push(
      `PUBLIC_BASE_URL is still the placeholder (${publicBase}). Run: npx cloudflared tunnel --url http://localhost:3000`,
    );
  } else if (servingHost && baseHost && servingHost !== baseHost) {
    /**
     * The split-brain check.
     *
     * A deployed service carrying someone's leftover cloudflared URL is a real
     * thing that has happened here, and it is the worst kind of failure: the URL
     * resolves, it looks legitimate, and every check above passes. But the
     * phones mutate game state in *this* process while Agora fetches /api/llm
     * from *that* one, so the host is handed state for a room that does not
     * exist where it is looking. Nothing errors. The host simply makes no sense.
     *
     * Deliberately not blocking. A cloudflared tunnel in front of localhost
     * mismatches on purpose, and so does any custom domain, so treating this as
     * fatal would cry wolf in the two setups that are actually correct. Loud,
     * not fatal.
     */
    warnings.push(
      `PUBLIC_BASE_URL points at ${baseHost} but this request was served by ${servingHost}. Expected when a tunnel or custom domain is in front. NOT expected on a deployment — Agora and Vobiz would be sent to a different process than the one holding the game, which fails silently. If ${servingHost} is serving the game, unset PUBLIC_BASE_URL and let it be derived.`,
    );
  }

  if (!keys.vobiz_auth_id || !keys.vobiz_auth_token || !keys.vobiz_from_number) {
    warnings.push(
      "Vobiz is not fully configured — Phone a Friend will fail (and refund, visibly).",
    );
  }
  const missingHints = hintAudio.filter((h) => !h.present);
  if (missingHints.length) {
    warnings.push(
      `${missingHints.length} of ${hintAudio.length} hint audio files are missing. Vobiz skips unreachable audio silently, so these become dead air on the call.`,
    );
  }
  const missingOutcome = outcomeAudio.filter((a) => !a.present);
  if (missingOutcome.length) {
    warnings.push(
      `Missing outcome stinger(s): ${missingOutcome.map((a) => a.file).join(", ")}.`,
    );
  }

  return NextResponse.json({
    ready: blocking.length === 0,
    blocking,
    warnings,
    keys,
    llm: {
      provider: optional("LLM_PROVIDER", "(inferred from URL)"),
      model: optional("LLM_MODEL", "openai/gpt-oss-120b"),
      upstream: optional("LLM_UPSTREAM_URL", "(default: Groq)"),
    },
    voice: {
      tts_speaker: optional("SARVAM_TTS_SPEAKER", "abhilash"),
      tts_language: optional("SARVAM_TTS_LANGUAGE", "hi-IN"),
      asr_language: optional("SARVAM_ASR_LANGUAGE", "unknown"),
    },
    publicBaseUrl: publicBase || null,
    // Which variable won. The most useful line in this payload when the
    // host speaks locally but not deployed, or vice versa.
    publicBaseSource,
    servingHost,
    audio: { hints: hintAudio, outcome: outcomeAudio },
    riddles: RIDDLES.map((r) => ({ wire: r.wire, id: r.id })),
    liveRooms: listGames().map((g) => ({
      code: g.code,
      phase: g.phase,
      players: g.players.length,
    })),
  });
}

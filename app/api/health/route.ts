import { NextResponse } from "next/server";
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
export async function GET() {
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
  const audioDir = join(process.cwd(), "public", "audio");

  // Checked on disk rather than trusted, because a missing file here is
  // inaudible rather than loud.
  const hintAudio = RIDDLES.map((r) => ({
    riddle: r.id,
    file: `/audio/hints/${r.id}_h1.wav`,
    present: existsSync(join(audioDir, "hints", `${r.id}_h1.wav`)),
  }));

  const outcomeAudio = [
    { name: "win", file: "win_wah_kya_baat_hai.wav" },
    { name: "lose", file: "lose_aag_aag.wav" },
  ].map((a) => ({
    ...a,
    present: existsSync(join(audioDir, "outcome", a.file)),
  }));

  const blocking: string[] = [];
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
  }

  const warnings: string[] = [];
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
    audio: { hints: hintAudio, outcome: outcomeAudio },
    riddles: RIDDLES.map((r) => ({ wire: r.wire, id: r.id })),
    liveRooms: listGames().map((g) => ({
      code: g.code,
      phase: g.phase,
      players: g.players.length,
    })),
  });
}

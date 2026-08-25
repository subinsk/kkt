import { NextResponse } from "next/server";
import { getGame } from "@/lib/game/store";
import { applyAck, registerAgoraLines, type Ack } from "@/lib/game/utterances";
import { AGORA_FAILURE_LINE, FILLER_PHRASES, PROXY_FALLBACK_LINE } from "@/lib/agent-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where clients report what the host actually said.
 *
 * # Why the acks come in over HTTP from a browser
 *
 * Agora publishes the agent's real transcript — `turn_id`, the text, and a status
 * of in-progress / end / **interrupted** — but only over RTM or the RTC data
 * stream, both of which are client-side channels. There is no server-side
 * equivalent: Agora's own docs put agent-state and interrupt events on the client
 * path exclusively, and webhooks give only coarse post-hoc records. So the
 * observation has to happen in a browser and be reported inward.
 *
 * The *decisions* stay here. The client says "turn 7 started speaking"; the
 * server decides what that means for the ledger, whether a deadline has passed,
 * and whether anything should be re-spoken. That keeps the rule from AGENTS.md
 * intact — the server owns the clock and the state, and a browser tab cannot vote
 * on either.
 *
 * # Any number of reporters
 *
 * Application is idempotent by `(turnId, status)`, so there is no leader election
 * and no designated tab. Two open projectors are redundancy rather than a race:
 * whichever reports first moves the ledger and the other is a no-op. That matters
 * because the alternative — one elected reporter — makes a closed browser tab
 * into a silent failure of the whole subtitle system.
 *
 * # Heartbeat
 *
 * A quiet host and a dead reporter look identical from here, and they must not:
 * with fail-closed rendering, mistaking one for the other blanks the projector
 * for the rest of the round. So a reporter posts on a cadence whether or not it
 * has anything to say, and the ledger tracks when it last heard from anybody. See
 * `isDegraded`.
 */

/**
 * Teach the classifier the lines Agora speaks on its own.
 *
 * Module scope, so it happens once when this route is first loaded. It lives here
 * rather than in `utterances.ts` so that module stays free of any dependency on
 * the Agora config — it is a state machine, and the checks drive it without one.
 */
registerAgoraLines(FILLER_PHRASES, [AGORA_FAILURE_LINE, PROXY_FALLBACK_LINE]);

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/ack">,
) {
  const { code } = await ctx.params;
  const game = getGame(code);
  if (!game) {
    return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    acks?: Partial<Ack>[];
    /** Set by a reporter that could not start. See `reporterError`. */
    error?: string;
  };

  /**
   * A reporter reporting its own failure.
   *
   * Recorded and returned early — deliberately WITHOUT touching the heartbeat,
   * because a reporter that cannot subscribe is not a reporter. The room stays
   * degraded (so the screens keep working off the estimate) and /api/health can
   * finally say why instead of showing an unexplained `degraded: true`.
   */
  if (typeof body.error === "string" && body.error) {
    game.utterances.reporterError = body.error.slice(0, 300);
    return NextResponse.json({ ok: true, recorded: "error" });
  }
  game.utterances.reporterError = null;

  /**
   * A body with no acks is a valid heartbeat, not a bad request.
   *
   * This is the common case by a wide margin — the host is silent most of a
   * round — and returning 400 for it would mean the only signal that the
   * transport is alive arrives exclusively when there is also something to say.
   */
  const results: string[] = [];
  for (const raw of body.acks ?? []) {
    if (
      typeof raw.turnId !== "number" ||
      (raw.status !== "speaking" &&
        raw.status !== "ended" &&
        raw.status !== "interrupted")
    ) {
      results.push("rejected");
      continue;
    }
    results.push(
      applyAck(game, {
        turnId: raw.turnId,
        status: raw.status,
        text: typeof raw.text === "string" ? raw.text : "",
        // The client's clock is not ours and cannot be trusted for a deadline.
        // It is accepted for ordering within a batch and nothing else.
        atMs: typeof raw.atMs === "number" ? raw.atMs : Date.now(),
      }),
    );
  }

  // Even an empty batch counts as "somebody is listening".
  game.utterances.lastAckHeartbeat = Date.now();

  return NextResponse.json({ ok: true, results });
}

import { NextResponse } from "next/server";
import {
  allPeerMode,
  cancelLifelineRequest,
  cutWire,
  grantLifeline,
  deferWire,
  emit,
  endGame,
  getGame,
  adjustClock,
  pauseClock,
  publicView,
  resetGame,
  requestLifeline,
  resumeClock,
  selectWire,
  setConnected,
  setPeerMode,
  setSpeaker,
  startGame,
} from "@/lib/game/store";
import { WIRE_COLORS, type WireColor } from "@/lib/game/state";
import { setHolding } from "@/lib/game/attribution";
import { startLifeline } from "@/lib/game/lifeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/room/DEMO/action — every mutation a client can ask for.
 *
 * One endpoint rather than a dozen, because these are all "tell the server
 * something changed" and they all return the same thing: the new public view.
 * The client never has to know which URL corresponds to which button.
 *
 * The host-console actions live here too. They are deliberately not
 * authenticated — this runs on a laptop on a desk for six minutes, and a login
 * screen between a misfiring attribution engine and the person who has to fix
 * it live would be the wrong trade.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/action">,
) {
  try {
    const { code } = await ctx.params;
    const game = getGame(code);
    if (!game) {
      return NextResponse.json({ error: `No room ${code}` }, { status: 404 });
    }

    const body = (await request.json()) as {
      type?: string;
      playerId?: string;
      peerMode?: boolean;
      holding?: boolean;
      connected?: boolean;
      color?: string;
      seconds?: number;
      reason?: string;
      outcome?: "won" | "lost";
    };

    const asColor = (value: unknown): WireColor => {
      const color = String(value ?? "").toLowerCase() as WireColor;
      if (!WIRE_COLORS.includes(color)) throw new Error(`Bad wire: ${value}`);
      return color;
    };

    switch (body.type) {
      /* -- contestant actions ------------------------------------------- */

      case "peer_mode": {
        if (!body.playerId) throw new Error("playerId required");
        setPeerMode(game, body.playerId, body.peerMode !== false);
        break;
      }

      /**
       * Hold-to-talk, kept as a momentary override on top of Peer Talk.
       *
       * Peer Talk is latched, which is right for a twenty-second discussion. But
       * for the single most consequential utterance in the game — the final
       * "lock kiya jaye" — you want a physical guarantee that attribution lands
       * on the person whose thumb is down.
       */
      case "hold": {
        if (!body.playerId) throw new Error("playerId required");
        setHolding(game.code, body.playerId, body.holding === true);
        if (body.holding) setSpeaker(game, body.playerId, false);
        emit(game, "hold_to_talk", {
          playerId: body.playerId,
          holding: body.holding === true,
        });
        break;
      }

      case "presence": {
        if (!body.playerId) throw new Error("playerId required");
        setConnected(game, body.playerId, body.connected !== false);
        break;
      }

      /**
       * A contestant asks for Phone a Friend.
       *
       * Raises a flag for the host rather than dialling. He offers the trade,
       * they say yes out loud, and only then does the tool fire the call.
       */
      case "request_lifeline": {
        if (!body.playerId) throw new Error("playerId required");
        requestLifeline(game, body.playerId);
        break;
      }

      case "cancel_lifeline":
        cancelLifelineRequest(game);
        break;

      /**
       * The contestant presses the unlocked button and the call goes out.
       *
       * `startLifeline` refuses unless the host has granted permission, so this
       * cannot be used to skip the asking.
       */
      case "use_lifeline": {
        if (!body.playerId) throw new Error("playerId required");
        // `call`, not `lifeline`: startLifeline returns call metadata, and
        // spreading it over publicView's `lifeline` wiped `granted` and `used`
        // on the client — so the button broke the instant it was pressed.
        const call = await startLifeline(game, body.playerId);
        return NextResponse.json({ ...publicView(game), call });
      }

      /** Host console override, for when he cannot hear the room. */
      case "grant_lifeline":
        grantLifeline(game, body.playerId ?? null);
        break;

      /* -- round flow --------------------------------------------------- */

      case "start":
        startGame(game);
        break;

      case "select_wire":
        selectWire(game, asColor(body.color));
        break;

      case "defer_wire":
        deferWire(game, asColor(body.color));
        break;

      /* -- host console ------------------------------------------------- */

      case "pause":
        pauseClock(game);
        break;

      case "resume":
        resumeClock(game);
        break;

      /** Disputed answer, or the semantic judge being too strict. */
      case "force_cut":
        cutWire(game, asColor(body.color), body.playerId ?? null);
        break;

      /** Negative burns clock, positive gives it back. */
      case "adjust_clock":
        adjustClock(
          game,
          -(Number(body.seconds) || 0),
          body.reason ?? "host adjustment",
        );
        break;

      /** The insurance policy for when attribution misfires in front of judges. */
      case "force_attribute":
        setSpeaker(game, body.playerId ?? null, false);
        break;

      case "all_peer_mode":
        allPeerMode(game, body.peerMode !== false);
        break;

      case "end_round":
        endGame(game, body.outcome ?? "lost", body.reason ?? "ended by host");
        break;

      case "reset":
        return NextResponse.json(publicView(resetGame(game)));

      default:
        return NextResponse.json(
          { error: `Unknown action: ${body.type}` },
          { status: 400 },
        );
    }

    return NextResponse.json(publicView(game));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

import {
  checkTimeout,
  eventsSince,
  getGame,
  publicView,
  secondsLeft,
  subscribe,
  sweepLifeline,
} from "@/lib/game/store";
import { sweepUtterances } from "@/lib/game/utterances";
import { hostSay } from "@/lib/game/host-speak";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 60s is the Vercel Hobby ceiling, and a round runs six minutes — so on Vercel
 * this stream gets cut once a minute. `useRoom` reconnects with `?since=<seq>`
 * and picks up where it left off, so it recovers, but it is a symptom of the
 * deeper mismatch described in docs/DEPLOY.md. On any normal Node host (Render,
 * Fly, local) the cap is simply never reached.
 */
export const maxDuration = 60;

/**
 * GET /api/room/DEMO/events — the live feed every screen listens to.
 *
 * Server-sent events rather than a WebSocket, because Next.js route handlers
 * cannot hold a socket open. That turns out to be fine: the traffic is almost
 * entirely server→client (wire cut, clock changed, someone went live), and the
 * one high-frequency client→server channel is level telemetry, which is a
 * batched POST. So a WebSocket would have bought a second protocol and a custom
 * server for no gain.
 *
 * Reconnect is handled by sequence number: pass `?since=N` and get everything
 * after N, rather than re-syncing blind and replaying animations that already
 * played.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/room/[code]/events">,
) {
  const { code } = await ctx.params;
  const found = getGame(code);

  if (!found) {
    return new Response(`No room ${code}`, { status: 404 });
  }
  /**
   * Re-pointed on every tick, never captured for the life of the stream.
   *
   * `resetGame` replaces the room object in the store, and a stream holding the
   * old one would report a frozen clock and a stale board while the real game
   * moved on. See the tick below.
   */
  let game = found;

  const url = new URL(request.url);
  const since = Number(url.searchParams.get("since") ?? 0);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          open = false;
        }
      };

      // Full state first, so a screen that just opened is correct immediately
      // rather than correct-once-something-happens.
      send("snapshot", publicView(game));

      // Then anything it missed while it was away.
      if (since > 0) {
        for (const event of eventsSince(game, since)) send("game", event);
      }

      const unsubscribe = subscribe(game.code, (event) => {
        send("game", event);
      });

      /**
       * The clock tick.
       *
       * Note what this is *not*: it is not the clock. `secondsLeft` is derived
       * from timestamps, and clients derive it too. This is a once-a-second
       * heartbeat that keeps every display honest, notices when the round has
       * run out, and doubles as the keep-alive that stops a proxy idling the
       * connection shut.
       */
      const ticker = setInterval(() => {
        if (!open) return;

        /**
         * Has the room expired out from under us?
         *
         * `getGame` is what runs the TTL sweep, so calling it here does double
         * duty: it closes a stream whose room is gone, and it means an idle room
         * with nothing but a projector attached still gets swept — otherwise the
         * only thing keeping it alive would be that no one had made an HTTP
         * request in an hour. The `room_expired` event has already reached this
         * subscriber by now; the sweep emits before it deletes.
         */
        /**
         * Re-resolve the room every tick, and use what comes back.
         *
         * This used to call `getGame` purely for its expiry side effect and then
         * report from the object captured when the stream opened. `resetGame`
         * replaces that object in the map, so a projector left open across a
         * reset would tick the *old* game forever — a frozen clock and a stale
         * board, with events still flowing from the real one.
         */
        const live = getGame(game.code);
        if (!live) {
          cleanup();
          return;
        }
        game = live;

        /**
         * The watchdogs run first, and cannot take the clock with them.
         *
         * `sweepLifeline` releases a call no webhook ever closed; `sweepUtterances`
         * releases a line nobody ever acknowledged. Same reasoning for both, and
         * the same shape: a deadline compared against a timestamp, never a counter
         * being decremented.
         *
         * They are wrapped because of what sits immediately below them. An
         * exception in either would skip `checkTimeout` and the `tick` send, so a
         * bug in a *subtitle* watchdog could stop the round from ever ending —
         * the clock would run past zero and the game would sit there. The
         * polling fallback in `use-room` would eventually expire it through the
         * GET route, so this is not the only guard, but nothing about speech
         * should be able to reach the clock at all.
         *
         * Loud, not silent: swallowing this would hide a broken watchdog for a
         * whole show.
         */
        try {
          sweepLifeline(game);
          sweepUtterances(game, (text) =>
            hostSay(game.code, text, { register: false }),
          );
        } catch (err) {
          console.error("[tick] watchdog failed, clock unaffected:", err);
        }
        const ended = checkTimeout(game);
        send("tick", {
          secondsLeft: secondsLeft(game),
          phase: game.phase,
          seq: game.seq,
        });
        if (ended) send("snapshot", publicView(game));
      }, 1000);

      const cleanup = () => {
        open = false;
        clearInterval(ticker);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends will buffer an event stream into uselessness.
      "X-Accel-Buffering": "no",
    },
  });
}

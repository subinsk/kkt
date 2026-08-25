"use client";

import { useEffect, useRef } from "react";
import type { IAgoraRTCClient } from "agora-rtc-sdk-ng";
import type { AgoraCredentials } from "./use-agora";

/**
 * Report what the host actually said.
 *
 * # Why a browser has to do this
 *
 * Agora publishes the agent's own transcript — the turn id, the text, and a
 * status of in-progress / end / **interrupted** — and that is the only
 * authoritative answer to "did he say it, and how much of it". But it is a
 * client-side channel: Agora's docs put agent-state and interrupt events on the
 * client path exclusively, and webhooks give only coarse records after the fact.
 * So the observation happens here and is reported inward, and the server decides
 * what it means. See `app/api/room/[code]/ack/route.ts`.
 *
 * # Only two seats run this
 *
 * The projector and the host console, because they are laptops and because the
 * server applies acks idempotently by `(turnId, status)` — so two reporters are
 * redundancy rather than a race, and a third on every handset would buy nothing.
 * A handset has no `rtmToken`, and this hook does nothing without one.
 *
 * # It is allowed to fail
 *
 * Every failure path here ends in the ledger simply never hearing a heartbeat,
 * which puts the room in `degraded` mode and the screens back on timing the
 * subtitle off the audio level — the behaviour that shipped before any of this
 * existed. That is deliberate: Signaling not being enabled for the project, an
 * RTM token mismatch, or a blocked WebSocket should cost sync accuracy, not the
 * subtitles themselves.
 */

/**
 * How often to tell the server we are still here.
 *
 * A quiet host and a dead reporter are indistinguishable from the server's side,
 * and with fail-closed rendering, mistaking one for the other blanks the
 * projector for the rest of the round. So this posts on a cadence whether or not
 * there is anything to say. Three of these fit inside `DEGRADE_AFTER_MS`, so one
 * dropped request does not flip the room into degraded mode.
 */
const HEARTBEAT_MS = 2000;

type AckOut = {
  turnId: number;
  status: "speaking" | "ended" | "interrupted";
  text: string;
  atMs: number;
};

export function useAckReporter(opts: {
  code: string;
  credentials: AgoraCredentials | null;
  clientRef: React.RefObject<IAgoraRTCClient | null>;
  joined: boolean;
}) {
  const { code, credentials, clientRef, joined } = opts;

  /**
   * Which `(turnId, status)` pairs have already been sent.
   *
   * `TRANSCRIPT_UPDATED` hands over the **entire** conversation history on every
   * update, not a delta — the toolkit's docs are explicit that consumers must
   * replace rather than append. Without this set, one update late in a round
   * would re-post every turn that had ever happened.
   */
  const sent = useRef(new Set<string>());
  const queue = useRef<AckOut[]>([]);

  useEffect(() => {
    if (!joined || !credentials?.rtmToken) return;

    let cancelled = false;
    let rtm: {
      logout: () => Promise<unknown>;
      subscribe: (channel: string, opts?: { withMessage?: boolean }) => Promise<unknown>;
      unsubscribe: (channel: string) => Promise<unknown>;
    } | null = null;
    let ai: {
      unsubscribe: () => void;
      destroy: () => void;
      subscribeMessage: (channel: string) => void;
    } | null = null;

    const flush = async (force: boolean) => {
      const batch = queue.current;
      if (!force && batch.length === 0) return;
      queue.current = [];
      try {
        await fetch(`/api/room/${encodeURIComponent(code)}/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acks: batch }),
          keepalive: true,
        });
      } catch {
        // Losing a batch costs sync accuracy for one line, and the heartbeat
        // will be along shortly. Re-queueing risks posting a stale status after
        // a newer one, which the server would have to reject as late anyway.
      }
    };

    /**
     * Armed only once the transport is genuinely up.
     *
     * It used to start here, before the RTM login, and that made the heartbeat a
     * lie: the ledger left degraded mode while the socket was still failing, so
     * the renderer switched to trusting acks that could never arrive. Worse than
     * staying degraded — degraded at least falls back to something that works.
     *
     * The heartbeat is the claim "somebody is watching the transcript". Nothing
     * may make that claim before it is true.
     */
    let beat: ReturnType<typeof setInterval> | null = null;
    const startHeartbeat = () => {
      if (beat) return;
      beat = setInterval(() => void flush(true), HEARTBEAT_MS);
    };

    void (async () => {
      try {
        // Both are browser-only and pull in a WebSocket stack; importing them at
        // module scope breaks the server render of every page using this hook.
        const [{ default: AgoraRTM }, toolkit] = await Promise.all([
          import("agora-rtm"),
          import("agora-agent-client-toolkit"),
        ]);
        const { AgoraVoiceAI, AgoraVoiceAIEvents, TurnStatus, MessageType } =
          toolkit;

        const client = clientRef.current;
        if (!client || cancelled) return;

        // Identity must match the token's subject — see the note in the
        // spectator route. A mismatch surfaces as a vague failure to start
        // rather than as an auth error.
        const rtmClient = new AgoraRTM.RTM(
          credentials.appId,
          String(credentials.uid),
        );
        await rtmClient.login({ token: credentials.rtmToken });
        console.debug("[kkt-rtm] RTM login resolved for uid", credentials.uid);
        if (cancelled) {
          await rtmClient.logout();
          return;
        }
        rtm = rtmClient;

        const instance = await AgoraVoiceAI.init({
          // The client that is already subscribed to the agent. A second client
          // would mean a second uid in the channel.
          rtcEngine: client as unknown as Parameters<
            typeof AgoraVoiceAI.init
          >[0]["rtcEngine"],
          rtmEngine: rtmClient as unknown as Parameters<
            typeof AgoraVoiceAI.init
          >[0]["rtmEngine"],
          /**
           * TEXT, not WORD.
           *
           * WORD would give per-word timings and true karaoke sync, but it needs
           * audio PTS metadata enabled before the RTC client is created, and it
           * depends on the TTS vendor supplying word timings at all — which is
           * why the toolkit ships a fallback for exactly this case. Whether
           * Sarvam Bulbul provides them is unverified. TEXT fixes *what* is
           * displayed, which is the whole of the divergence problem; sync
           * accuracy is the smaller, later win.
           */
          /**
           * TEXT. WORD was tried and it does not work with this stack.
           *
           * WORD mode would give `words[].start_ms` against the audio clock —
           * true karaoke sync, and the only route to a subtitle that matches the
           * voice exactly rather than approximately. Measured on 25 Aug 2026,
           * three runs, with `ENABLE_AUDIO_PTS_METADATA` set before
           * `createClient` and `enableRenderModeFallback` both defaulted and set
           * explicitly:
           *
           *   - Sarvam supplies **no word timings at all**
           *   - and asking for WORD stops the **agent** transcript arriving
           *     entirely, while the user transcript still comes through
           *
           * So it is not a trade of accuracy for risk — it is strictly worse.
           * TEXT gives one transcript per turn, at its end, which is what the
           * ledger needs. See docs/AGORA-NOTES.md.
           */
          renderMode: toolkit.TranscriptHelperMode.TEXT,
          /**
           * On, and left on.
           *
           * Everything this hook does is invisible when it works and invisible
           * when it does not — the room simply falls back to estimating. The
           * SDK's own log is the only account of why, and `scripts/browser-check`
           * reads it back out of the page console.
           */
          enableLog: true,
        });
        if (cancelled) {
          instance.destroy();
          return;
        }
        ai = instance;

        /**
         * When he starts talking — which the transcript does not tell us.
         *
         * In `TEXT` render mode a sentence arrives once, already finished, with
         * status END. That is fine for *what* was said and useless for *when*:
         * with only END acks the ledger would never hold a line in `speaking`,
         * so the bubble's start gate would never open and fail-closed rendering
         * would show nothing at all.
         *
         * `AGENT_STATE_CHANGED` is the missing half, and it carries a `turnID`,
         * which `AGENT_SPEAKING_CHANGED` does not. So: state for the timing,
         * transcript for the words. Exactly the split the level-threshold
         * heuristic was standing in for.
         */
        /**
         * Registered, and unreliable — never depend on it.
         *
         * With `enable_rtm` + `data_channel: "rtm"` set and the channel
         * subscribed for both messages and presence, several runs produced
         * nothing but transcripts — no state changes at all — and a later run
         * produced one. So it fires sometimes. Measured 25 Aug 2026; see
         * docs/AGORA-NOTES.md.
         *
         * Left in place because it costs nothing and is the correct source for
         * turn-start if it ever starts working. Nothing depends on it: the
         * reveal is timed off the audio itself, which is the only signal
         * genuinely in lockstep with what the room hears.
         */
        instance.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_uid, event) => {
          console.debug(
            "[kkt-rtm] agent state:",
            String(event.state),
            "turnID:",
            String(event.turnID),
          );
          if (event.state !== "speaking" || typeof event.turnID !== "number") {
            return;
          }
          const key = `${event.turnID}:speaking`;
          if (sent.current.has(key)) return;
          sent.current.add(key);
          queue.current.push({
            turnId: event.turnID,
            status: "speaking",
            text: "",
            atMs: event.timestamp ?? Date.now(),
          });
          void flush(false);
        });

        instance.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (items) => {
          /**
           * Say what arrived, before any filtering.
           *
           * The filter below drops everything that is not the agent, so a wrong
           * `agentUid` — or a transcript whose uid does not identify the agent at
           * all, which AGENTS.md flags as an unverified assumption — looks
           * exactly like no transcripts arriving. One line naming the uids we
           * actually saw is the difference between diagnosing that in a minute
           * and guessing at it.
           */
          /**
           * Does the TTS vendor actually supply word timings?
           *
           * The whole question of exact-vs-approximate sync reduces to this one
           * line. WORD mode is requested, but the toolkit falls back to TEXT
           * when the server sends no timings — silently, by design — so asking
           * for it proves nothing. Counting them does.
           */
          const timed = items.filter(
            (i) =>
              Array.isArray(
                (i.metadata as { words?: unknown[] } | null)?.words,
              ) &&
              ((i.metadata as { words?: unknown[] }).words?.length ?? 0) > 0,
          );
          if (timed.length) {
            const w = (
              timed[0].metadata as {
                words: { word: string; start_ms: number; duration_ms: number }[];
              }
            ).words;
            console.debug(
              "[kkt-rtm] WORD TIMINGS PRESENT:",
              w.length,
              "words, first:",
              JSON.stringify(w.slice(0, 3)),
            );
          } else {
            console.debug("[kkt-rtm] no word timings on this update");
          }

          console.debug(
            "[kkt-rtm] transcript:",
            `expecting agent uid ${credentials.agentUid};`,
            items
              .map(
                (i) =>
                  `{uid:${i.uid} stream:${i.stream_id} turn:${i.turn_id} status:${i.status} obj:${
                    (i.metadata as { object?: string } | null)?.object ?? "-"
                  }}`,
              )
              .join(" "),
          );
          for (const item of items) {
            /**
             * Agent turns only.
             *
             * The same stream carries what the contestants said, and reporting
             * those as host acks would have the bubble subtitling the room. The
             * uid check is the primary test; the metadata `object` is a second
             * one for the case where uid does not distinguish them.
             */
            const isAgent =
              item.uid === String(credentials.agentUid) ||
              item.metadata?.object === MessageType.AGENT_TRANSCRIPTION;
            if (!isAgent) continue;

            const status =
              item.status === TurnStatus.END
                ? "ended"
                : item.status === TurnStatus.INTERRUPTED
                  ? "interrupted"
                  : "speaking";

            const key = `${item.turn_id}:${status}`;
            if (sent.current.has(key)) continue;
            sent.current.add(key);
            queue.current.push({
              turnId: item.turn_id,
              status,
              text: item.text ?? "",
              atMs: item._time ?? Date.now(),
            });
          }
          // Do not wait for the heartbeat — a subtitle waiting two seconds for
          // its own start signal would be worse than the estimate it replaced.
          void flush(false);
        });

        /**
         * Subscribe LAST, and only after the handler above is registered.
         *
         * Both halves matter. Without this call nothing arrives at all — the
         * toolkit is initialised, the RTM client is logged in, and the stream is
         * simply never opened; there is no error to see. And the order is the
         * toolkit's own documented rule: messages already in flight when
         * `subscribeMessage` runs are delivered immediately, so a handler
         * registered afterwards misses them.
         *
         * The RTM channel name is the RTC channel name.
         */
        /**
         * Subscribe the RTM client to the channel. The toolkit does not.
         *
         * This is the line that was missing, and it is invisible from the
         * outside: the toolkit attaches `addEventListener("message")` to the RTM
         * engine and never calls `subscribe()` on it — you can read that in its
         * bundle — because it treats the RTM lifecycle as the app's job, exactly
         * as it treats `rtcClient.join()`. So `subscribeMessage()` was arming a
         * listener on a channel this client had never joined. Login succeeded,
         * the toolkit reported nothing wrong, and no message ever arrived.
         *
         * Order matters, and the SDK says so: "You need to listen to events
         * before calling, such as `message` ... otherwise you may miss some
         * events." So the toolkit's listeners go on first, then this.
         */
        /**
         * Both channels, explicitly.
         *
         * Transcripts arrive as RTM channel **messages**; agent state — the
         * `speaking` / `thinking` / `listening` transitions, and the only signal
         * that says *when* a line starts — arrives as RTM **presence**. Subscribed
         * with `withMessage` alone, the transcript worked and not a single state
         * event ever fired, which left the ledger with a turn's end and no
         * beginning. Both flags default to true, but naming them is the
         * difference between knowing that and assuming it.
         */
        await rtmClient.subscribe(credentials.channel, {
          withMessage: true,
          withPresence: true,
        });
        instance.subscribeMessage(credentials.channel);
        console.debug(
          "[kkt-rtm] subscribed to",
          credentials.channel,
          "as uid",
          credentials.uid,
          "— watching for agent uid",
          credentials.agentUid,
        );
        startHeartbeat();
      } catch (err) {
        /**
         * Fail softly, but never silently.
         *
         * Signaling not enabled for the App ID, an RTM token minted for a
         * different identity, a blocked WebSocket — all of them land here, and
         * all of them are survivable: the room stays degraded and the screens go
         * back to timing the subtitle off the audio level. Nothing here is worth
         * breaking a live round over.
         *
         * But swallowing the reason would make this indistinguishable from
         * "nobody opened the projector", and those need completely different
         * fixes. So it goes two places: the browser console for whoever has the
         * tab open, and the server, so `/api/health` can say it out loud to
         * somebody who does not.
         */
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[kkt-rtm] transcript reporter could not start:", err);
        try {
          await fetch(`/api/room/${encodeURIComponent(code)}/ack`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: reason }),
          });
        } catch {
          // If even this cannot be delivered, the console line is what is left.
        }
      }
    })();

    return () => {
      cancelled = true;
      if (beat) clearInterval(beat);
      try {
        ai?.unsubscribe();
        ai?.destroy();
      } catch {
        // Already gone.
      }
      void (async () => {
        try {
          await rtm?.unsubscribe(credentials.channel);
        } catch {
          // Logging out drops it anyway.
        }
        await rtm?.logout().catch(() => {});
      })();
    };
  }, [code, credentials, clientRef, joined]);
}

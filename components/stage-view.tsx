"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import QRCode from "qrcode";
import { StageCanvas } from "./stage/stage-canvas";
import { useHostLine, idOf } from "@/lib/use-host-line";
import { useAckReporter } from "@/lib/rtm";
import { useRoom, formatClock } from "@/lib/use-room";
import { RoomGone } from "@/components/room-gone";
import { useAgora, configuredMode, type AgoraCredentials } from "@/lib/use-agora";
import { WIRE_LABELS_EN, type WireColor } from "@/lib/game/state";

/**
 * The projector — spec §3.
 *
 * A broadcast view: the audience watches the show, the contestants watch their
 * phones. So the 3D set carries the drama and a DOM chyron carries the text,
 * because DOM text stays crisp at projector scale where canvas text does not.
 *
 * This is also the only device that plays audio in Mode A. One voice source in
 * the room means no comb filtering and no phone-to-phone feedback.
 */

/**
 * The outcome stingers — real takes, not the host's synthesised voice.
 *
 * `render-hints.ts` can generate stand-ins for these, and said so itself: a
 * placeholder in the host's own voice beats silence, but a recorded take beats
 * the placeholder. These are the takes, so they are what plays. The generated
 * `*_wah_kya_baat_hai.wav` / `*_aag_aag.wav` files are no longer read by
 * anything.
 */
const OUTCOME_AUDIO = {
  win: "/audio/outcome/win.mp3",
  lose: "/audio/outcome/lose.mp3",
};

export default function StageView({ code }: { code: string }) {
  const { game, connected, missing, onEvent } = useRoom(code);
  const [credentials, setCredentials] = useState<AgoraCredentials | null>(null);
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [qrWarning, setQrWarning] = useState(false);
  const [minimal, setMinimal] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [menuIn, setMenuIn] = useState<number | null>(null);
  const router = useRouter();

  const agora = useAgora({
    role: "stage",
    credentials,
    mode: configuredMode(),
  });

  /**
   * The host's lines, queued rather than overwritten.
   *
   * Everything he says arrives here from the LLM proxy before TTS. It is a queue
   * because Agora plays its own outbound lines in order, so two arriving close
   * together are both spoken — and the old single-slot state showed only the
   * second. See lib/use-host-line.ts.
   */
  const { line: hostLine, lineDone } = useHostLine(onEvent);

  /**
   * Report the host's real transcript inward, so the ledger has acks to act on.
   *
   * Silent no-op without an `rtmToken`, and every failure inside it leaves the
   * room `degraded` — which falls back to timing the subtitle off the audio
   * level, exactly as before this existed.
   */
  useAckReporter({
    code,
    credentials,
    clientRef: agora.clientRef,
    joined: agora.joined,
  });

  /**
   * Server truth when the acks are flowing; the local queue when they are not.
   *
   * These are the two halves of a fail-closed design. With a reporter alive, the
   * ledger knows which line is actually being spoken and how much of it came
   * out, so that wins. With nobody reporting, insisting on acks would mean no
   * subtitles at all — so the client-side queue takes over and the line is timed
   * off the audio level.
   *
   * For an interrupted line the text shown is what was actually SPOKEN, not what
   * was intended. That is the whole point of keeping the two apart: printing the
   * rest of a riddle the room never heard hands over the answer.
   */
  const degraded = game?.host?.degraded ?? true;
  const served = game?.host?.current ?? null;
  const line =
    !degraded && served
      ? {
          id: idOf(served.id),
          text:
            served.status === "interrupted" && served.spoken
              ? served.spoken
              : served.text,
        }
      : hostLine;
  const lineStatus = degraded ? null : (served?.status ?? null);

  /**
   * Has this round already begun, according to the server?
   *
   * `started` is local state, so a projector reload forgot the round had ever
   * happened: it offered "Start the game" over a finished board, and pressing it
   * re-joined a host who opened with the greeting again while the screen still
   * read "phat gaya". The server knows — anything other than `lobby` means the
   * lobby panel has no business being on screen.
   */
  const roundBegun = game ? game.phase !== "lobby" : false;
  const roundFinished = game?.phase === "won" || game?.phase === "lost";

  const outcomeSfx = useRef<Record<string, HTMLAudioElement>>({});
  const playedOutcome = useRef(false);

  /** `?minimal=1` strips post-processing and particles — the escape hatch. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setMinimal(params.get("minimal") === "1");
  }, []);

  /**
   * The QR contestants scan.
   *
   * The URL comes from the server, not from `window.location.origin`. The
   * projector is usually open on localhost, and a QR encoding localhost resolves
   * to the *phone* when scanned — so it silently fails for every contestant. The
   * server knows whether a tunnel or a deployment URL is in front of it.
   */
  useEffect(() => {
    let alive = true;

    const render = async () => {
      // Ask the server where the QR should point. It is the only side that
      // knows whether a tunnel or a deployment URL sits in front of us.
      let url = `${window.location.origin}/join/${code}`;
      let reachable = !/localhost|127\.0\.0\.1/i.test(window.location.origin);

      try {
        const res = await fetch(`/api/join-url?code=${encodeURIComponent(code)}`);
        if (res.ok) {
          const d = (await res.json()) as {
            joinUrl?: string;
            reachable?: boolean;
          };
          if (d.joinUrl) url = d.joinUrl;
          if (typeof d.reachable === "boolean") reachable = d.reachable;
        }
      } catch {
        // Fall through to the origin-derived URL below. A QR pointing at the
        // wrong host is still better than no QR — the whole screen exists to be
        // scanned, and an empty box tells a contestant nothing.
      }

      if (!alive) return;
      setJoinUrl(url);
      setQrWarning(!reachable);

      try {
        const png = await QRCode.toDataURL(url, {
          margin: 1,
          width: 320,
          color: { dark: "#f2ece2ff", light: "#00000000" },
          errorCorrectionLevel: "M",
        });
        if (alive) setQr(png);
      } catch {
        if (alive) setQr(null);
      }
    };

    void render();
    return () => {
      alive = false;
    };
  }, [code]);

  /**
   * The Start gesture, and it does four things that all have to happen on the
   * same click.
   *
   * The unlock is the subtle one: browsers block audio that is not tied to a
   * user gesture, and the outcome stinger fires *minutes* after the last click.
   * So both files get played-and-immediately-paused here, while we still have a
   * gesture to spend. Without this the endgame is silent and there is no error.
   */
  const start = useCallback(async () => {
    /**
     * Nothing to start. The board is finished and the host must not re-greet.
     *
     * Belt to the braces of hiding the panel: a stale click, a double tap, or a
     * keyboard activation could still land here, and the cost is the opening
     * line playing over a scoreboard. Use the host console's reset to play again.
     */
    if (roundFinished) {
      setNote("This round is over. Reset it from the host console to play again.");
      return;
    }
    setStarting(true);
    setNote(null);
    try {
      for (const [key, src] of Object.entries(OUTCOME_AUDIO)) {
        const audio = new Audio(src);
        audio.preload = "auto";
        audio.volume = 0;
        /**
         * Restore the volume whatever happens to the silent unlock.
         *
         * This is the bug that made the endgame silent. The unlock plays each
         * clip at volume 0 to spend the click, and the volume was only put back
         * inside `.then()`. When `play()` rejected — autoplay policy, a slow
         * decode, anything — the catch swallowed it and the element was left at
         * **volume 0 forever**. Minutes later the stinger played perfectly and
         * nobody heard a thing, the `ended` event fired on schedule, and the
         * closing line followed as if it had worked. Nothing in any log.
         */
        const rearm = () => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = 1;
        };
        audio.play().then(rearm).catch(rearm);
        outcomeSfx.current[key] = audio;
      }

      // Same gesture pays for the AudioContext.
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (Ctor) void new Ctor().resume();
      } catch {
        // Non-fatal.
      }

      const spectator = await fetch(`/api/room/${code}/spectator`).then((r) =>
        r.json(),
      );
      if (spectator.error) throw new Error(spectator.error);
      setCredentials(spectator as AgoraCredentials);

      await fetch(`/api/room/${code}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "start" }),
      });

      /**
       * The host is NOT started here — see the effect below.
       *
       * His opening line is spoken the moment he joins the channel, with no LLM
       * turn behind it. Starting him now would have him greet a channel this
       * projector has not finished subscribing to, so the introduction and the
       * first riddle are simply lost — and twenty seconds later the silence
       * prompt fires instead, which is the stray line that sounds like the host
       * malfunctioning.
       */
      setStarted(true);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not start");
    } finally {
      setStarting(false);
    }
  }, [code, roundFinished]);

  /**
   * Bring the host in only once this projector is subscribed and listening.
   *
   * `agora.joined` is the guarantee that the greeting has an audience. Guarded by
   * a ref so a re-render cannot start a second agent.
   */
  const hostRequested = useRef(false);
  useEffect(() => {
    if (!started || !agora.joined || hostRequested.current) return;
    hostRequested.current = true;

    void fetch(`/api/room/${code}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setNote(String(d.error));
      })
      .catch((err) => setNote(err instanceof Error ? err.message : "The host did not arrive"));
  }, [started, agora.joined, code]);

  /** Chyron copy, driven off the event feed. */
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "wire_selected") {
          setCaption(String(event.payload.screen ?? ""));
        }
        if (event.type === "hint_given") {
          setCaption(`HINT — ${String(event.payload.hint ?? "")}`);
        }
        if (event.type === "wrong_answer") {
          setCaption(
            `${String(event.payload.playerName ?? "Someone")}: "${String(
              event.payload.text ?? "",
            )}" — wrong`,
          );
        }
        if (event.type === "wire_cut") {
          setCaption(
            `${String(event.payload.color ?? "").toUpperCase()} KAT GAYA`,
          );
        }
      }),
    [onEvent],
  );

  /**
   * Play the outcome stinger once, then hand the closing line back to the host
   * on the audio's `ended` event rather than a fixed timeout. The delay reads as
   * a beat instead of a bug, and it stops him talking over the MP3.
   */
  useEffect(() => {
    if (!game || playedOutcome.current) return;
    if (game.phase !== "won" && game.phase !== "lost") return;
    playedOutcome.current = true;

    const key = game.phase === "won" ? "win" : "lose";
    /**
     * Fall back to a fresh element if the unlock never ran on this surface.
     *
     * `start()` preloads both clips, but the round can begin without it — the
     * host console has its own start button, and a projector reloaded mid-round
     * never sees one. There was then no preloaded element at all, so the stinger
     * was skipped silently and only the closing line landed.
     */
    const audio =
      outcomeSfx.current[key] ??
      (() => {
        const fresh = new Audio(OUTCOME_AUDIO[key as "win" | "lose"]);
        outcomeSfx.current[key] = fresh;
        return fresh;
      })();
    // Whatever path produced this element, it must be audible.
    audio.volume = 1;

    /**
     * Three separate things race to trigger this — the stinger ending, the
     * stinger failing to start, and the fallback timeout — and exactly one of
     * them should win. A rejected `play()` used to satisfy both the catch and
     * the timeout, which had the host deliver his closing line twice over the
     * top of himself, at the single most important beat in the show.
     */
    let spoken = false;
    const closingLine = async () => {
      if (spoken) return;
      spoken = true;

      const text =
        game.phase === "won"
          ? "Wah! Kya baat hai! Aap sabne kar dikhaya. Taaliyan!"
          : "Arre arre arre... ghadi khatam. Coffee machine band, ek hafte ke liye!";
      await fetch(`/api/room/${code}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "speak", text, interruptable: false }),
      }).catch(() => {});
    };

    if (audio) {
      audio.addEventListener("ended", () => void closingLine(), { once: true });
      audio.addEventListener(
        "playing",
        () => console.info("[kkt-stinger] playing", key),
        { once: true },
      );
      audio.play().catch((err) => {
        // Loud. A silent endgame is the most visible failure in the show, and it
        // has now happened once for a reason nothing recorded.
        console.error("[kkt-stinger] could not play", key, err);
        void closingLine();
      });
      // If the file is absent or blocked the stinger silently never plays, so
      // make sure the closing line still lands. `paused` flips false the moment
      // play() is called, so a clip that is merely still buffering does not trip
      // this.
      setTimeout(() => {
        if (audio.paused && audio.currentTime === 0) void closingLine();
      }, 900);
    } else {
      void closingLine();
    }
  }, [game, code]);

  /**
   * After the outcome, offer the way out — do not just take it.
   *
   * A projector that navigates itself away mid-applause is worse than one that
   * waits: the scoreboard is the thing people photograph. So it counts down
   * visibly and can be cancelled, and the countdown is generous enough to read
   * the numbers and take a picture.
   */
  useEffect(() => {
    if (!game) return;
    const over = game.phase === "won" || game.phase === "lost";
    if (!over) {
      setMenuIn(null);
      return;
    }
    if (menuIn !== null) return;
    setMenuIn(30);
  }, [game, menuIn]);

  useEffect(() => {
    if (menuIn === null) return;
    if (menuIn <= 0) {
      router.push("/");
      return;
    }
    const t = setTimeout(() => setMenuIn((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [menuIn, router]);

  const secondsLeft = game?.secondsLeft ?? 360;
  const panic = secondsLeft <= 60 && game?.phase === "running";

  if (!game) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        {missing ? (
          <div>
            <p className="display text-4xl uppercase" style={{ color: "var(--signal-red)" }}>
              Room {code} not found
            </p>
            <p className="mt-3 text-sm" style={{ color: "var(--cream-dim)" }}>
              No room has that code. The host can open a new one.
            </p>
            <a href="/" className="btn btn-brass mt-6 inline-block px-6 py-3">
              Main menu
            </a>
          </div>
        ) : (
          <p className="label">Connecting to room {code}…</p>
        )}
      </main>
    );
  }

  return (
    <main className="relative h-dvh w-dvw overflow-hidden bg-[var(--ink)]">
      {/* The room is gone but state is stale — say so over everything. */}
      {missing && <RoomGone code={code} />}

      {/* ---------------------------------------------------------- 3D --- */}
      <StageCanvas
        game={game}
        agentLevelRef={agora.agentLevelRef}
        minimal={minimal}
        interactive
        resetToken={resetToken}
        hostLine={line}
        lineStatus={lineStatus}
        wordsPerSecond={game?.host?.wordsPerSecond ?? null}
        onLineDone={lineDone}
        className="absolute inset-0"
      />

      {/* Hand the camera back to the automatic shot. Bottom-left, out of the
          way of the chyron, and unobtrusive until you have moved something. */}
      <div className="absolute bottom-8 left-8 z-10 flex items-center gap-2">
        <button
          onClick={() => setResetToken((n) => n + 1)}
          className="btn px-3 py-1.5 text-[0.7rem] opacity-45 hover:opacity-100"
          title="Drag to orbit · scroll to zoom · right-drag to pan"
        >
          Reset camera
        </button>
        {/**
         * The way to the operator's panel for THIS room.
         *
         * Without it the only route to /host/<code> was typing the code by hand,
         * which is how you end up with the console watching a different room
         * than the phones joined — it reports zero contestants and looks broken
         * when everything is working correctly.
         */}
        <a
          href={`/host/${code}`}
          target="_blank"
          rel="noreferrer"
          className="btn px-3 py-1.5 text-[0.7rem] opacity-45 hover:opacity-100"
          title="Operator controls for this room"
        >
          Host panel
        </a>
      </div>

      {/* Studio vignette + scanlines, over the render. */}
      <div className="vignette scanlines pointer-events-none absolute inset-0" />

      {/* ------------------------------------------------------- title --- */}
      {/* The wordmark, sized for a projector at the back of a room. */}
      <div className="pointer-events-none absolute left-8 top-7 w-56">
        <h1>
          <Image
            src="/kkt-logo.png"
            alt="Kaun Katega Taarpati"
            width={1104}
            height={678}
            priority
            className="h-auto w-full"
          />
        </h1>
      </div>

      {/* ------------------------------------------------------- clock --- */}
      <div className="pointer-events-none absolute right-8 top-5 text-right">
        <p
          className={`numerals text-7xl leading-none ${panic ? "panic" : ""}`}
          style={{
            color:
              game.phase === "won"
                ? "var(--signal-green)"
                : panic
                  ? undefined
                  : "var(--cream)",
          }}
        >
          {formatClock(secondsLeft)}
        </p>
        <div className="mt-1 flex items-center justify-end gap-2">
          <span
            className={`lamp lamp-on ${connected ? "lamp-green" : "lamp-red"}`}
          />
          <span className="label-dim">
            {game.wires.filter((w) => w.status === "cut").length} / 5 cut
          </span>
        </div>
      </div>

      {/**
       * Lifeline status, with its deadline.
       *
       * A phone ringing in the room is the beat people remember, so the screen
       * has to say it is happening. The countdown matters as much: a ring
       * indicator with no end looks identical to a hang, and this one is telling
       * the room the system will give up on its own if nobody picks up.
       */}
      {game.lifeline.limit > 0 && (
        <div className="pointer-events-none absolute right-8 top-32 text-right">
          <div
            className="panel px-4 py-2.5"
            style={{ borderColor: "var(--signal-amber)" }}
          >
            <p className="label" style={{ color: "var(--signal-amber)" }}>
              {game.lifeline.status === "connected"
                ? "Friend on the line"
                : "Phone a friend · ringing"}
            </p>
            <p
              className="numerals text-3xl leading-none"
              style={{ color: "var(--signal-amber)" }}
            >
              {Math.max(0, game.lifeline.limit - game.lifeline.waiting)}s
            </p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------- contestants --- */}
      <div className="pointer-events-none absolute bottom-32 left-8 space-y-2">
        <p className="label">Contestants</p>
        {game.players.length === 0 && (
          <p className="text-sm" style={{ color: "var(--cream-faint)" }}>
            Scan the QR code to join
          </p>
        )}
        {game.players.map((p) => {
          const live = game.live.includes(p.id);
          const speaking = game.lastSpeaker === p.id;
          return (
            <div key={p.id} className="flex items-center gap-2.5">
              <span
                className={`lamp ${live ? "lamp-on" : ""}`}
                style={live ? { background: p.color } : undefined}
              />
              <span
                className="display text-2xl uppercase leading-none"
                style={{
                  color: speaking ? p.color : live ? "var(--cream)" : "var(--cream-faint)",
                }}
              >
                {p.name}
              </span>
              {live && (
                <span
                  className="label"
                  style={{ color: "var(--signal-red)" }}
                >
                  on air
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/**
       * No lower-third chyron.
       *
       * It used to run the question and the last transcript along the bottom of
       * the frame. It went because the speech bubble does the same job better:
       * text attached to the person saying it reads as speech, where a caption
       * bar at the foot of the screen reads as a subtitle and competes with the
       * set for attention. The riddle also stays on every contestant's phone,
       * which is where they actually look while answering.
       */}

      {/* ------------------------------------------------------ outcome --- */}
      {(game.phase === "won" || game.phase === "lost") && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p
              className="display text-[9rem] uppercase leading-none"
              style={{
                color:
                  game.phase === "won"
                    ? "var(--signal-green)"
                    : "var(--signal-red)",
                textShadow: `0 0 60px ${
                  game.phase === "won" ? "#3dd68c" : "#e5484d"
                }`,
              }}
            >
              {game.phase === "won" ? "Defused" : "Phat gaya"}
            </p>
            <p className="mt-2 text-2xl" style={{ color: "var(--cream-dim)" }}>
              {game.phase === "won"
                ? `${formatClock(secondsLeft)} left · ${game.hintsUsed} hint${
                    game.hintsUsed === 1 ? "" : "s"
                  } · lifeline ${game.lifeline.used ? "used" : "unused"}`
                : `${game.wires.filter((w) => w.status !== "cut").length} wires left`}
            </p>

            {/* The exit, offered rather than taken. */}
            {menuIn !== null && (
              <div className="pointer-events-auto mt-8 flex items-center justify-center gap-3">
                <button
                  onClick={() => router.push("/")}
                  className="btn btn-brass px-6 py-3"
                >
                  Main menu ({menuIn})
                </button>
                <button onClick={() => setMenuIn(null)} className="btn px-6 py-3">
                  Yahin ruko
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------- start gate --- */}
      {/**
       * The start gate sits over the set, not on top of it.
       *
       * This used to be an 86%-opaque blurred sheet across the whole frame,
       * which hid the thing people are here to look at — judges walked up to a
       * dark rectangle with a QR code on it. Now the room is fully visible and
       * only the panel itself is solid, so the set is doing its job from the
       * first second.
       */}
      {!started && !roundBegun && (
        <div className="absolute inset-0 grid place-items-center">
          {/* Just enough scrim to keep the panel legible against the render. */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 46% 62% at 50% 50%, rgb(6 5 4 / 0.82) 0%, rgb(6 5 4 / 0.35) 60%, transparent 100%)",
            }}
          />
          <div className="panel relative w-full max-w-md px-8 py-7 text-center">
            <p className="label">Room</p>
            <p
              className="numerals text-7xl leading-none"
              style={{ color: "var(--brass)" }}
            >
              {code}
            </p>

            {qr && (
              <div className="mt-5 inline-block panel-sunken p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt={`Join room ${code}`} className="size-44" />
              </div>
            )}

            {joinUrl && (
              <p
                className="mt-3 break-all font-mono text-[0.7rem]"
                style={{ color: qrWarning ? "var(--signal-red)" : "var(--cream-faint)" }}
              >
                {joinUrl.replace(/^https?:\/\//, "")}
              </p>
            )}

            {qrWarning && (
              <p
                className="mt-2 text-xs"
                style={{ color: "var(--signal-red)" }}
              >
                This is localhost — a phone cannot open it. Start the tunnel
                and set PUBLIC_BASE_URL.
              </p>
            )}

            <p className="mt-4 text-lg" style={{ color: "var(--cream-dim)" }}>
              Scan with your phone — one to four players. Then we begin.
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--cream-faint)" }}>
              {game.players.length === 1
                ? "Playing alone works — you go straight on air."
                : "We start with whoever has joined."}
            </p>

            <div className="mt-4 flex items-center justify-center gap-2">
              <span className="label-dim">Joined</span>
              <span className="display text-3xl">
                {game.players.length}
              </span>
            </div>

            <button
              onClick={start}
              disabled={starting || game.players.length === 0}
              className="btn btn-brass mt-6 w-full py-5 text-lg"
            >
              {starting
                ? "Bringing the host in…"
                : game.players.length === 0
                  ? "Waiting for players…"
                  : "Start the game"}
            </button>

            {note && (
              <p className="mt-4 text-sm" style={{ color: "var(--signal-red)" }}>
                {note}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Audio status, small and out of the way. */}
      {started && (
        <div className="pointer-events-none absolute right-8 bottom-28 text-right">
          <div className="flex items-center justify-end gap-2">
            <span
              className={`lamp ${agora.agentPresent ? "lamp-on lamp-green" : "lamp-on lamp-amber"}`}
            />
            <span className="label-dim">
              {agora.agentPresent ? "host live" : "host joining"}
            </span>
          </div>
        </div>
      )}
    </main>
  );
}

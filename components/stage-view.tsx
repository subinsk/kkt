"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { StageCanvas } from "./stage/stage-canvas";
import { useRoom, formatClock } from "@/lib/use-room";
import { useAgora, configuredMode, type AgoraCredentials } from "@/lib/use-agora";
import { WIRE_LABELS_HI, type WireColor } from "@/lib/game/state";

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

const OUTCOME_AUDIO = {
  win: "/audio/outcome/win_wah_kya_baat_hai.wav",
  lose: "/audio/outcome/lose_aag_aag.wav",
};

export default function StageView({ code }: { code: string }) {
  const { game, connected, onEvent } = useRoom(code);
  const [credentials, setCredentials] = useState<AgoraCredentials | null>(null);
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [minimal, setMinimal] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [hostSaid, setHostSaid] = useState<string | null>(null);

  const agora = useAgora({
    role: "stage",
    credentials,
    mode: configuredMode(),
  });

  const outcomeSfx = useRef<Record<string, HTMLAudioElement>>({});
  const playedOutcome = useRef(false);

  /** `?minimal=1` strips post-processing and particles — the escape hatch. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setMinimal(params.get("minimal") === "1");
  }, []);

  /** The QR judges scan. Points at the join page for this room. */
  useEffect(() => {
    const url = `${window.location.origin}/join/${code}`;
    QRCode.toDataURL(url, {
      margin: 1,
      width: 320,
      color: { dark: "#f2ece2ff", light: "#00000000" },
      errorCorrectionLevel: "M",
    })
      .then(setQr)
      .catch(() => setQr(null));
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
    setStarting(true);
    setNote(null);
    try {
      for (const [key, src] of Object.entries(OUTCOME_AUDIO)) {
        const audio = new Audio(src);
        audio.preload = "auto";
        audio.volume = 0;
        audio
          .play()
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.volume = 1;
          })
          .catch(() => {
            // A missing file is a warning, not a failure — /api/health reports it.
          });
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

      const agent = await fetch(`/api/room/${code}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }).then((r) => r.json());
      if (agent.error) throw new Error(agent.error);

      await fetch(`/api/room/${code}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "start" }),
      });

      setStarted(true);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not start");
    } finally {
      setStarting(false);
    }
  }, [code]);

  /** Chyron copy, driven off the event feed. */
  useEffect(
    () =>
      onEvent((event) => {
        // Everything the host says, straight from the LLM proxy before TTS.
        if (event.type === "host_said" || event.type === "agent_spoke") {
          setHostSaid(String(event.payload.text ?? ""));
        }
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
            )}" — nahi`,
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
    const audio = outcomeSfx.current[key];

    const closingLine = async () => {
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
      audio.play().catch(() => void closingLine());
      // If the file is absent the stinger silently never plays, so make sure
      // the closing line still lands.
      setTimeout(() => {
        if (audio.paused && audio.currentTime === 0) void closingLine();
      }, 900);
    } else {
      void closingLine();
    }
  }, [game, code]);

  const secondsLeft = game?.secondsLeft ?? 360;
  const panic = secondsLeft <= 60 && game?.phase === "running";

  if (!game) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="label">Connecting to room {code}…</p>
      </main>
    );
  }

  return (
    <main className="relative h-dvh w-dvw overflow-hidden bg-[var(--ink)]">
      {/* ---------------------------------------------------------- 3D --- */}
      <StageCanvas
        game={game}
        agentLevelRef={agora.agentLevelRef}
        minimal={minimal}
        interactive
        resetToken={resetToken}
        hostSaid={hostSaid}
        className="absolute inset-0"
      />

      {/* Hand the camera back to the automatic shot. Bottom-left, out of the
          way of the chyron, and unobtrusive until you have moved something. */}
      <button
        onClick={() => setResetToken((n) => n + 1)}
        className="btn absolute bottom-28 left-8 z-10 px-3 py-1.5 text-[0.7rem] opacity-45 hover:opacity-100"
        title="Drag to orbit · scroll to zoom · right-drag to pan"
      >
        Reset camera
      </button>

      {/* Studio vignette + scanlines, over the render. */}
      <div className="vignette scanlines pointer-events-none absolute inset-0" />

      {/* ------------------------------------------------------- title --- */}
      <div className="pointer-events-none absolute left-8 top-7">
        <p className="label">Kaun Katega</p>
        <h1 className="display text-4xl uppercase leading-none">
          Taar<span style={{ color: "var(--brass)" }}>pati</span>
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
            {game.wires.filter((w) => w.status === "cut").length} / 5 kate
          </span>
        </div>
      </div>

      {/* ------------------------------------------------- contestants --- */}
      <div className="pointer-events-none absolute bottom-32 left-8 space-y-2">
        <p className="label">Contestants</p>
        {game.players.length === 0 && (
          <p className="text-sm" style={{ color: "var(--cream-faint)" }}>
            QR scan karke join karo
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

      {/* ------------------------------------------------------ chyron --- */}
      {/**
       * Lower third. This carries the room when ASR is imperfect and makes the
       * conversation legible to people standing at the back — the single
       * highest-value piece of UI on this screen.
       */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        <div
          className="border-t px-8 py-4"
          style={{
            background:
              "linear-gradient(180deg, transparent, rgb(6 5 4 / 0.94) 38%)",
            borderColor: "var(--rule)",
          }}
        >
          <div className="flex items-end gap-6">
            <div
              className="shrink-0 px-3 py-1"
              style={{ background: "var(--brass)", color: "#1a1206" }}
            >
              <span className="display text-xl uppercase leading-none">
                {game.activeWire
                  ? `${WIRE_LABELS_HI[game.activeWire as WireColor]} taar`
                  : "Sawaal"}
              </span>
            </div>
            <p className="min-h-8 flex-1 text-2xl leading-snug">
              {caption ??
                (game.activeWire
                  ? "…"
                  : "Amitabh bhai poochhenge — kis taar se shuru karein?")}
            </p>
            {/* Lifeline status, right-aligned in the chyron. A phone ringing
                in the room is the beat judges remember, so the screen has to
                say what is happening while it happens. */}
            {(game.lifeline.activeFor || game.lifeline.requestedBy) && (
              <span
                className="label shrink-0 animate-pulse"
                style={{ color: "var(--signal-amber)" }}
              >
                {game.lifeline.status === "connected"
                  ? "friend on the line"
                  : game.lifeline.status === "ringing"
                    ? "ringing…"
                    : game.lifeline.status === "dialing"
                      ? "calling…"
                      : "lifeline requested"}
              </span>
            )}
          </div>
        </div>
      </div>

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
                ? `${formatClock(secondsLeft)} bacha · ${game.hintsUsed} hint${
                    game.hintsUsed === 1 ? "" : "s"
                  } · lifeline ${game.lifeline.used ? "use hui" : "bachi"}`
                : `${game.wires.filter((w) => w.status !== "cut").length} taar bache the`}
            </p>
          </div>
        </div>
      )}

      {/* -------------------------------------------------- start gate --- */}
      {!started && (
        <div className="absolute inset-0 grid place-items-center bg-[rgb(6_5_4/0.86)] backdrop-blur-sm">
          <div className="w-full max-w-lg px-8 text-center">
            <p className="label">Room</p>
            <p
              className="numerals text-8xl leading-none"
              style={{ color: "var(--brass)" }}
            >
              {code}
            </p>

            {qr && (
              <div className="mt-6 inline-block panel p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt={`Join room ${code}`} className="size-52" />
              </div>
            )}

            <p className="mt-5 text-lg" style={{ color: "var(--cream-dim)" }}>
              Phone se scan karein — ek se chaar log. Phir shuru.
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--cream-faint)" }}>
              {game.players.length === 1
                ? "Akele bhi chalega — aap seedha on air honge."
                : "Jitne aaye hain, utne se shuru ho jaayega."}
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
                ? "Amitabh bhai aa rahe hain…"
                : game.players.length === 0
                  ? "Kisi ka intezaar…"
                  : "Game shuru karo"}
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

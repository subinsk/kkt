"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRoom, formatClock } from "@/lib/use-room";
import { useHostLine } from "@/lib/use-host-line";
import { RoomGone } from "@/components/room-gone";
import {
  useAgora,
  configuredMode,
  AGENT_SPEAKING_LEVEL,
  type AgoraCredentials,
} from "@/lib/use-agora";
import { SEAT_COLORS, WIRE_LABELS_EN, type WireColor } from "@/lib/game/state";
import { StageCanvas } from "@/components/stage/stage-canvas";
import {
  Mic,
  MicOff,
  PhoneCall,
  Lock,
  Hand,
  Users,
  Clock,
  Scissors,
  Lightbulb,
  XCircle,
  Trophy,
  Flame,
  Home,
  Wifi,
  WifiOff,
} from "lucide-react";

/**
 * The contestant's handset — spec §4, plus Peer Talk.
 *
 * Deliberately sparse. Their eyes belong on the big screen and on each other;
 * this is a control surface they operate by feel while looking somewhere else.
 * So: few controls, all large, and the one that matters is unmissable.
 *
 * The set renders here too, at the top of the screen. A contestant should be
 * able to watch their own wire get cut without looking up, and the phone is
 * where their eyes already are when they are answering.
 *
 * It runs in `minimal` mode: no shadows, no antialiasing, no particles. Three
 * phones already carrying WebRTC with open mics is the fragile part of this
 * system, and the difference between a shadowed render and an unshadowed one is
 * not worth a dropped frame in the middle of an answer.
 */

type Joined = {
  player: {
    id: string;
    uid: number;
    name: string;
    seat: number;
    peerMode: boolean;
    hasPhone: boolean;
  };
  rtc: AgoraCredentials;
};

export default function PhoneConsole({ code }: { code: string }) {
  const [session, setSession] = useState<Joined | null>(null);

  if (!session) {
    return <JoinForm code={code} onJoined={setSession} />;
  }
  return <Console code={code} session={session} />;
}

/* -------------------------------------------------------------------------- */
/* Joining                                                                    */
/* -------------------------------------------------------------------------- */

function JoinForm({
  code,
  onJoined,
}: {
  code: string;
  onJoined: (s: Joined) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Refs alongside state, because of autofill.
   *
   * A browser filling these in does not reliably fire React's `onChange`, so
   * state can still be empty while the fields visibly contain a name and a
   * number. Gating the button on state then leaves the contestant staring at a
   * dead button with their details already on screen — which is exactly what
   * happened.
   *
   * So: state drives the live feedback, the refs are the truth on submit, and
   * the button is never disabled on validity. Validation happens when they
   * press it and says what is wrong.
   */
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  /** Ten digits, ignoring spaces, dashes, a leading +91, and a leading zero. */
  const normalise = (raw: string) =>
    raw
      .replace(/\D/g, "")
      .replace(/^0+/, "")
      .replace(/^91(?=\d{10}$)/, "");

  const digits = normalise(phone);
  const phoneOk = digits.length === 10;
  const nameOk = name.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    // Read the DOM, so an autofilled value counts even if onChange never fired.
    const liveName = (nameRef.current?.value ?? name).trim();
    const liveDigits = normalise(phoneRef.current?.value ?? phone);

    if (!liveName) {
      setError("Naam likhiye.");
      nameRef.current?.focus();
      return;
    }
    if (liveDigits.length !== 10) {
      setError(
        `Das digit ka mobile number chahiye — abhi ${liveDigits.length} hai.`,
      );
      phoneRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/room/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The number is required now, so entering it *is* the consent — the
        // notice below the field says so in as many words.
        body: JSON.stringify({
          name: (nameRef.current?.value ?? name).trim(),
          phone: normalise(phoneRef.current?.value ?? phone),
          consent: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not join");
      onJoined(data as Joined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-dvh scanlines">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
        <header className="mb-8">
          <p className="label">Room {code}</p>
          {/* First thing a contestant sees after the QR scan. */}
          <h1 className="mt-3 w-full max-w-[15rem]">
            <Image
              src="/kkt-logo.png"
              alt="Kaun Katega Taarpati"
              width={1104}
              height={678}
              priority
              className="h-auto w-full"
            />
          </h1>
          <p className="mt-3 text-sm" style={{ color: "var(--cream-dim)" }}>
            Five wires. Six minutes. You are a contestant.
          </p>
        </header>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className="label-dim mb-2 block" htmlFor="name">
              Your name
            </label>
            <input
              id="name"
              ref={nameRef}
              // Uncontrolled: autofill and IME both write straight to the DOM,
              // and `defaultValue` keeps React from fighting them.
              defaultValue={name}
              onChange={(e) => setName(e.target.value)}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              required
              maxLength={24}
              autoComplete="given-name"
              autoFocus
              placeholder="Rahul"
              className="panel-sunken w-full px-4 py-3 text-lg outline-none focus:border-[var(--brass)]"
            />
          </div>

          <div>
            <label className="label-dim mb-2 block" htmlFor="phone">
              Mobile number
            </label>
            <input
              id="phone"
              ref={phoneRef}
              defaultValue={phone}
              onChange={(e) => setPhone(e.target.value)}
              onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
              required
              inputMode="numeric"
              autoComplete="tel"
              maxLength={17}
              placeholder="98765 43210"
              className="panel-sunken w-full px-4 py-3 text-lg outline-none focus:border-[var(--brass)]"
              style={{
                borderColor:
                  phone.length > 0 && !phoneOk ? "var(--signal-red)" : undefined,
              }}
            />
            {/**
             * Consent as a plain notice rather than a checkbox.
             *
             * The number is required, so a checkbox would be a gate with only
             * one passable state — theatre, not consent. What actually matters
             * is that the person reads what happens to it before they type it,
             * so the notice sits under the field and says exactly that.
             */}
            <p
              className="mt-2 text-xs leading-snug"
              style={{ color: "var(--cream-faint)" }}
            >
              {phone.length > 0 && !phoneOk
                ? `${digits.length}/10 digits`
                : "Used only for Phone a Friend. Deleted the moment the game ends — never stored, never shared."}
            </p>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "var(--signal-red)" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn btn-brass w-full py-4 text-base"
          >
            {busy ? "Taking your seat…" : "Take my seat"}
          </button>

          <p
            className="text-center text-xs"
            style={{ color: "var(--cream-faint)" }}
          >
            Your browser will ask for mic permission. You have to allow it —
            the whole game runs on talking.
          </p>
        </form>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Playing                                                                    */
/* -------------------------------------------------------------------------- */

function Console({ code, session }: { code: string; session: Joined }) {
  const { game, connected, missing, onEvent, act } = useRoom(code);
  const [peerMode, setPeerMode] = useState(true);
  const [pending, setPending] = useState(false);
  const [lifelineNote, setLifelineNote] = useState<string | null>(null);

  /** Drop a stale lifeline message the moment the host acts on it. */
  useEffect(() => {
    if (game?.lifeline.granted) setLifelineNote(null);
  }, [game?.lifeline.granted]);

  /** Feed the speech bubble in the handset's own view of the set. */
  const { line: hostLine, lineDone } = useHostLine(onEvent);

  /**
   * Follow the server's view of whether this handset is on air.
   *
   * The floor is exclusive — somebody else going live mutes us — and that
   * decision is made on the server. But the *publishing* decision lives here:
   * the server flipping a flag does not take a track off the wire. Without this
   * effect the two disagree in the worst direction, with our mic still
   * publishing while LIVE STATE tells the host he cannot hear us — so he ignores
   * a contestant who is talking to him, and attribution names the wrong person
   * with total confidence.
   *
   * Skipped while a toggle of our own is in flight, so a snapshot that predates
   * our own press cannot undo it.
   */
  const serverPeerMode = game?.players.find(
    (p) => p.id === session.player.id,
  )?.peerMode;
  useEffect(() => {
    if (pending || serverPeerMode === undefined) return;
    if (serverPeerMode !== peerMode) setPeerMode(serverPeerMode);
  }, [serverPeerMode, pending, peerMode]);

  const lifelineSpent = game?.lifeline.used ?? false;
  const lifelineActive = game?.lifeline.activeFor === session.player.id;
  const requestedByMe = game?.lifeline.requestedBy === session.player.id;
  const lifelineGranted = game?.lifeline.granted ?? false;
  const requestedBySomeone = Boolean(game?.lifeline.requestedBy);
  const roundOver = game?.phase === "won" || game?.phase === "lost";

  /**
   * The outcome stinger, on the handset too.
   *
   * The original reasoning was that three phones firing the same file a few
   * hundred milliseconds apart sounds terrible — and it does, in one room. But a
   * phone that goes silent at the payoff is worse: a contestant holding it hears
   * nothing at the moment the game is won. So it plays here as well, quietly,
   * and the projector remains the loud one.
   *
   * Unlocked on the Peer Talk toggle rather than on a dedicated gesture, because
   * that is a button every contestant presses early and browsers only arm audio
   * on a real interaction.
   */
  const stingers = useRef<Record<string, HTMLAudioElement>>({});
  const stingerPlayed = useRef(false);

  const unlockStingers = () => {
    if (Object.keys(stingers.current).length) return;
    for (const [key, src] of Object.entries({
      won: "/audio/outcome/win.mp3",
      lost: "/audio/outcome/lose.mp3",
    })) {
      const audio = new Audio(src);
      audio.preload = "auto";
      // Muted for the priming play() only — see rearm below.
      audio.volume = 0;
      /**
       * Restore the real volume whether the priming play resolved or rejected.
       *
       * This used to live only in `.then()`, which meant a rejected unlock — the
       * common case, since a toggle press is not always a strong enough gesture
       * — left `volume` at 0 permanently. The stinger then "played" at the
       * payoff in perfect silence, with nothing in any log to say so. The stage
       * had the identical bug.
       */
      const rearm = () => {
        audio.pause();
        audio.currentTime = 0;
        // Quieter than the room speaker — this is a companion, not the source.
        audio.volume = 0.55;
      };
      audio.play().then(rearm).catch(rearm);
      stingers.current[key] = audio;
    }
  };

  useEffect(() => {
    if (!roundOver || stingerPlayed.current || !game) return;
    stingerPlayed.current = true;
    stingers.current[game.phase]?.play().catch(() => {});
  }, [roundOver, game]);

  /**
   * How long the outcome beat holds before the scoreboard appears.
   *
   * Matched to the stinger plus the tail of the confetti and fire on the
   * projector — long enough to feel like an ending, short enough that nobody is
   * waiting for their score.
   */
  const [showBeat, setShowBeat] = useState(false);
  useEffect(() => {
    if (!roundOver) {
      setShowBeat(false);
      return;
    }
    setShowBeat(true);
    const t = setTimeout(() => setShowBeat(false), 5200);
    return () => clearTimeout(t);
  }, [roundOver]);


  const agora = useAgora({
    role: "player",
    credentials: session.rtc,
    mode: configuredMode(),
    playerId: session.player.id,
    roomCode: code,
    peerMode,
    // §9.5 and §10.2 — see the option's own note.
    forceSilent: lifelineActive || roundOver,
  });

  const seatColor = SEAT_COLORS[session.player.seat] ?? SEAT_COLORS[0];
  const secondsLeft = game?.secondsLeft ?? 0;
  const panic = secondsLeft <= 60 && game?.phase === "running";
  // Read from the hook, so the pill can never claim live while muted.
  const live = !agora.muted;

  /**
   * A one-player room, where Peer Talk has nothing on the other end.
   *
   * `game` is null for the first render or two, and `?? 1` would call that
   * solo — so default to *not* solo and let the first state push decide. A
   * three-player room briefly mislabelled as solo would come on air without
   * anyone asking, which is the one outcome to avoid.
   */
  const solo = game?.players.length === 1;

  /** Keep the server's view of who is live in step with the local toggle. */
  async function togglePeer() {
    // Spend the gesture on arming the outcome audio while we have one.
    unlockStingers();
    const next = !peerMode;
    setPeerMode(next);
    setPending(true);
    try {
      await act({
        type: "peer_mode",
        playerId: session.player.id,
        peerMode: next,
      });
    } catch {
      // Revert so the button never lies about whether the host can hear you.
      setPeerMode(!next);
    } finally {
      setPending(false);
    }
  }

  /**
   * Come on air automatically when playing alone.
   *
   * `startGame` does the same thing server-side, but the publish decision lives
   * on the phone — the server flipping a flag does not put a track on the wire.
   * So the handset mirrors it: once, on the first running state that shows a
   * one-player room. Guarded by a ref rather than by `peerMode`, so a solo
   * player who deliberately mutes themselves afterwards stays muted.
   */
  const cameOnAir = useRef(false);
  useEffect(() => {
    if (cameOnAir.current) return;
    if (!solo || !peerMode || game?.phase !== "running") return;
    cameOnAir.current = true;
    void togglePeer();
  });

  /**
   * Duck our own capture while the host is talking.
   *
   * Driven off the host's measured level rather than a server event, because
   * the leak we are fighting is acoustic and arrives with the audio.
   */
  useEffect(() => {
    agora.duck(agora.agentLevel > AGENT_SPEAKING_LEVEL);
  }, [agora.agentLevel, agora]);

  /** Tell the server we left, so the projector can dim an empty seat. */
  useEffect(() => {
    const bye = () => {
      void fetch(`/api/room/${code}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "presence",
          playerId: session.player.id,
          connected: false,
        }),
        keepalive: true,
      });
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, [code, session.player.id]);

  /**
   * Ask for the lifeline. Deliberately does not dial.
   *
   * The tap raises a flag the host sees; he offers the trade out loud and waits
   * for a spoken yes. A button that placed a real phone call and burned
   * forty-five seconds on one accidental thumb would be indefensible.
   */
  /**
   * One button, three meanings, and the host controls which.
   *
   * Locked → asking. Granted → actually dialling. The middle state exists so a
   * careless thumb cannot spend forty-five seconds of a six-minute round, while
   * the host's permission still means something.
   */
  /**
   * One button, three meanings, and the host controls which.
   *
   * Locked → asking. Granted → dialling. The middle state exists so a careless
   * thumb cannot spend forty-five seconds of a six-minute round while the host's
   * permission still means something.
   *
   * Every failure surfaces. This used to swallow errors, which made "the host
   * has not granted it yet", "no wire is selected" and "Vobiz is down" all look
   * identical to a dead button — unfixable by the person holding the phone.
   */
  async function askForLifeline() {
    if (lifelineSpent || roundOver) return;
    setLifelineNote(null);
    try {
      if (lifelineGranted) {
        const next = (await act({
          type: "use_lifeline",
          playerId: session.player.id,
        })) as unknown as { call?: { error?: string; status?: string } };
        if (next.call?.error) setLifelineNote(next.call.error);
        else setLifelineNote("Placing the call…");
      } else if (requestedByMe) {
        await act({ type: "cancel_lifeline" });
      } else {
        await act({ type: "request_lifeline", playerId: session.player.id });
        setLifelineNote("Host se poochha hai — ruko.");
      }
    } catch (err) {
      setLifelineNote(
        err instanceof Error ? err.message : "The lifeline did not go through.",
      );
    }
  }



  /**
   * Once the round ends, this handset stops being a control surface and becomes
   * a scoreboard — spec §10.4.
   *
   * Per-phone rather than a shared screen because the interesting number is
   * *personal*: "you cut two of the five" is a different sentence for each
   * contestant, and it is the one they will screenshot.
   *
   * Derived from game state rather than from the `game_over` event, so a phone
   * that reloads, or joins late, still shows the right numbers.
   */
  // The server has forgotten this room. Everything below is stale.
  if (missing) return <RoomGone code={code} />;

  /**
   * Let the outcome land before the scoreboard takes the screen.
   *
   * The round ending used to swap straight to the summary, which cut the payoff
   * off at the knees: the stinger is playing through the room speakers, the set
   * is mid-confetti or mid-fireball, and every contestant is already staring at
   * a table of statistics. The numbers are not the moment — the moment is the
   * moment. So the phone shows the outcome over the set for as long as the beat
   * runs, and only then becomes a scoreboard.
   */
  if (roundOver && showBeat && game) {
    const won = game.phase === "won";
    return (
      <main className="relative min-h-dvh scanlines">
        <div className="absolute inset-0">
          <StageCanvas
            game={game}
            agentLevelRef={agora.agentLevelRef}
            minimal
            hostLine={hostLine}
            onLineDone={lineDone}
            className="absolute inset-0"
          />
        </div>
        <div
          className="absolute inset-0 grid place-items-center px-6 text-center"
          style={{
            background: won
              ? "radial-gradient(ellipse at center, rgb(6 5 4 / 0.3), rgb(6 5 4 / 0.85))"
              : "radial-gradient(ellipse at center, rgb(40 6 2 / 0.35), rgb(6 5 4 / 0.88))",
          }}
        >
          <div>
            <p
              className="display text-6xl uppercase leading-none"
              style={{
                color: won ? "var(--signal-green)" : "var(--signal-red)",
                textShadow: `0 0 50px ${won ? "#3dd68c" : "#e5484d"}`,
              }}
            >
              {won ? "Defused" : "Detonated"}
            </p>
            <p className="mt-3 text-lg" style={{ color: "var(--cream-dim)" }}>
              {won ? "Five out of five!" : "The clock won."}
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (roundOver && game) {
    return (
      <Summary
        game={game}
        playerId={session.player.id}
        playerName={session.player.name}
        seatColor={seatColor}
      />
    );
  }

  return (
    <main
      className="relative min-h-dvh scanlines transition-colors duration-300"
      style={{
        background: live
          ? "linear-gradient(180deg, var(--oxblood-deep) 0%, var(--ink) 45%)"
          : "var(--ink)",
      }}
    >
      {/* On-air rail. The peripheral cue for a person looking at the projector. */}
      <div
        className="fixed inset-x-0 top-0 z-20 h-1 transition-all duration-200"
        style={{
          background: live ? "var(--signal-red)" : "transparent",
          boxShadow: live ? "0 0 16px var(--signal-red)" : "none",
        }}
      />

      {/**
       * The set, on the handset.
       *
       * Same scene component as the projector, so a contestant watches their own
       * wire get cut without looking up — and the phone is where their eyes
       * already are while they are answering.
       *
       * `minimal` and a low DPR ceiling: no shadows, no antialiasing, no
       * particles. Three phones already carrying WebRTC with open mics is the
       * fragile part of this system, and a shadowed render is not worth a dropped
       * frame mid-answer. Draggable, so they can look around between questions.
       */}
      {game && (
        <div className="relative h-[36vh] w-full">
          <StageCanvas
            game={game}
            agentLevelRef={agora.agentLevelRef}
            minimal
            interactive
            hostLine={hostLine}
            onLineDone={lineDone}
            className="absolute inset-0"
          />
          {/* Fade the bottom edge into the panel below it. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
            style={{
              background: "linear-gradient(180deg, transparent, var(--ink))",
            }}
          />
        </div>
      )}

      <div className="mx-auto max-w-md px-5 pb-8 pt-3">
        {/* -- header ------------------------------------------------------ */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="block size-3"
                style={{ background: seatColor }}
                aria-hidden
              />
              <span className="display text-2xl uppercase">
                {session.player.name}
              </span>
            </div>
            <p className="label-dim mt-1">
              Seat {session.player.seat + 1} · Room {code}
            </p>
          </div>

          <div className="text-right">
            <p
              className={`numerals text-5xl leading-none ${panic ? "panic" : ""}`}
              style={{ color: panic ? undefined : "var(--cream)" }}
            >
              {formatClock(secondsLeft)}
            </p>
            <div className="mt-1 flex items-center justify-end gap-1.5">
              {connected ? (
                <Wifi size={12} style={{ color: "var(--signal-green)" }} />
              ) : (
                <WifiOff size={12} style={{ color: "var(--signal-red)" }} />
              )}
            </div>
          </div>
        </div>

        {/* -- wires ------------------------------------------------------- */}
        <section className="mt-6">
          <p className="label mb-2 flex items-center gap-1.5"><Scissors size={11} />Taar</p>
          <div className="panel flex justify-between gap-2 p-3">
            {(game?.wires ?? []).map((w) => (
              <WirePip
                key={w.color}
                color={w.color as WireColor}
                status={w.status}
                active={game?.activeWire === w.color}
              />
            ))}
          </div>
        </section>

        {/* -- question ---------------------------------------------------- */}
        <section className="mt-5">
          <p className="label mb-2 flex items-center gap-1.5">
            <Lightbulb size={11} />
            {game?.activeWire
              ? WIRE_LABELS_EN[game.activeWire as WireColor] + " wire"
              : "Question"}
          </p>
          <div className="panel-sunken min-h-24 p-4">
            <p className="text-lg leading-snug">
              {game?.activeWire ? (
                <ActiveRiddle code={code} wire={game.activeWire as WireColor} />
              ) : (
                <span style={{ color: "var(--cream-faint)" }}>
                  Tell the host which wire to start with.
                </span>
              )}
            </p>
          </div>
        </section>

        {/* -- the hero control -------------------------------------------- */}
        <section className="mt-7">
          <button
            onClick={togglePeer}
            disabled={pending || !agora.micReady || lifelineActive || roundOver}
            className="w-full rounded-full px-6 py-7 text-left transition-all duration-200 disabled:opacity-40"
            style={{
              background: live ? "var(--signal-red)" : "var(--ink-raised)",
              border: `1px solid ${live ? "var(--signal-red)" : "var(--rule)"}`,
              boxShadow: live
                ? "0 0 28px color-mix(in srgb, var(--signal-red) 45%, transparent)"
                : "inset 0 1px 0 color-mix(in srgb, var(--brass) 10%, transparent)",
              color: live ? "#fff" : "var(--cream)",
            }}
          >
            <span className="flex items-center justify-between">
              <span>
                <span className="display block text-3xl uppercase">
                  {lifelineActive
                    ? "Mic band"
                    : roundOver
                      ? "Khatam"
                      : live
                        ? "On air"
                        : solo
                          ? "Mic off"
                          : "Peer talk"}
                </span>
                <span className="mt-1 block text-sm opacity-80">
                  {lifelineActive
                    ? "Call in progress — hold the phone to your ear"
                    : roundOver
                      ? "Round complete"
                      : live
                        ? "The host is listening"
                        : solo
                          ? "The host cannot hear you — tap to speak"
                          : "You can all talk — the host cannot hear you"}
                </span>
              </span>
              <span
                className="block size-4 shrink-0"
                style={{
                  background: live ? "#fff" : "var(--cream-faint)",
                  boxShadow: live ? "0 0 12px #fff" : "none",
                }}
                aria-hidden
              />
            </span>
          </button>
          <p
            className="mt-2 text-center text-xs"
            style={{ color: "var(--cream-faint)" }}
          >
            {lifelineActive
              ? solo
                ? "Listen, then answer"
                : "Tell the others what you heard afterwards"
              : roundOver
                ? "Watch the screen"
                : live
                  ? solo
                    ? "Tap to mute — thinking time is free"
                    : "Tap to rejoin the discussion"
                  : "Tap to answer · thinking is free"}
          </p>
        </section>

        {/* -- secondary --------------------------------------------------- */}
        <section className="mt-6 grid grid-cols-2 gap-3">
          <HoldToTalk
            code={code}
            playerId={session.player.id}
            disabled={!agora.micReady}
          />
          <button
            onClick={askForLifeline}
            disabled={lifelineSpent || roundOver}
            className="panel flex flex-col items-center justify-center gap-1.5 p-3 text-center transition-colors disabled:opacity-45"
            style={{
              borderColor: lifelineActive
                ? "var(--signal-amber)"
                : lifelineGranted
                  ? "var(--signal-green)"
                  : requestedByMe
                    ? "var(--brass)"
                    : undefined,
              background: lifelineGranted && !lifelineActive
                ? "color-mix(in srgb, var(--signal-green) 12%, var(--ink-raised))"
                : requestedByMe
                  ? "color-mix(in srgb, var(--brass) 14%, var(--ink-raised))"
                  : undefined,
            }}
          >
            {lifelineActive ? (
              <PhoneCall size={22} className="animate-pulse" style={{ color: "var(--signal-amber)" }} />
            ) : lifelineSpent ? (
              <PhoneCall size={22} style={{ color: "var(--cream-faint)" }} />
            ) : lifelineGranted ? (
              <PhoneCall size={22} style={{ color: "var(--signal-green)" }} />
            ) : (
              <Lock size={22} style={{ color: "var(--cream-faint)" }} />
            )}
            <span className="display text-lg uppercase leading-none">
              {lifelineActive
                ? "On call"
                : lifelineSpent
                  ? "Used"
                  : lifelineGranted
                    ? "Call now"
                    : requestedByMe
                      ? "Requested"
                      : "Lifeline"}
            </span>
            <span className="text-[0.65rem] leading-tight" style={{ color: "var(--cream-faint)" }}>
              {lifelineActive
                ? "Mic band"
                : lifelineSpent
                  ? "—"
                  : lifelineGranted
                    ? "−45s"
                    : "Ask the host"}
            </span>
          </button>
        </section>

        {/**
         * The wait, with a visible deadline.
         *
         * A ring indicator with no end is indistinguishable from a hang. Showing
         * the ceiling means a contestant knows the system has not forgotten
         * them, and that it will give up on its own.
         */}
        {game && game.lifeline.limit > 0 && (
          <div
            className="panel mt-3 flex items-center justify-between gap-3 p-3"
            style={{ borderColor: "var(--signal-amber)" }}
          >
            <span className="flex items-center gap-2 text-sm">
              <PhoneCall size={15} className="animate-pulse" style={{ color: "var(--signal-amber)" }} />
              {game.lifeline.status === "connected"
                ? "Call in progress — listen"
                : "Ringing…"}
            </span>
            <span className="numerals text-lg" style={{ color: "var(--signal-amber)" }}>
              {Math.max(0, game.lifeline.limit - game.lifeline.waiting)}s
            </span>
          </div>
        )}

        {lifelineNote && (
          <p
            className="mt-2 text-center text-xs"
            style={{ color: "var(--signal-amber)" }}
          >
            {lifelineNote}
          </p>
        )}

        {/* Who else the host can hear — makes contested states legible. */}
        <section className="mt-6">
          <p className="label mb-2 flex items-center gap-1.5"><Users size={11} />On air</p>
          <div className="flex flex-wrap gap-2">
            {(game?.players ?? []).map((p) => {
              const isLive = (game?.live ?? []).includes(p.id);
              return (
                <span
                  key={p.id}
                  className="flex items-center gap-2 border px-3 py-1.5 text-sm"
                  style={{
                    borderColor: isLive ? p.color : "var(--rule)",
                    color: isLive ? "var(--cream)" : "var(--cream-faint)",
                    background: isLive
                      ? `color-mix(in srgb, ${p.color} 12%, transparent)`
                      : "transparent",
                  }}
                >
                  <span
                    className={`lamp ${isLive ? "lamp-on" : ""}`}
                    style={isLive ? { background: p.color } : undefined}
                  />
                  {p.name}
                </span>
              );
            })}
          </div>
        </section>

        {agora.error && (
          <p className="mt-6 text-sm" style={{ color: "var(--signal-red)" }}>
            Mic problem: {agora.error}
          </p>
        )}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Post-game summary                                                          */
/* -------------------------------------------------------------------------- */

function Summary({
  game,
  playerId,
  playerName,
  seatColor,
}: {
  game: NonNullable<ReturnType<typeof useRoom>["game"]>;
  playerId: string;
  playerName: string;
  seatColor: string;
}) {
  const won = game.phase === "won";
  const cutByMe = game.wires.filter((w) => w.cutBy === playerId).length;
  const cutTotal = game.wires.filter((w) => w.status === "cut").length;
  const remaining = game.wires.filter((w) => w.status !== "cut");

  const board = game.players
    .map((p) => ({
      ...p,
      cuts: game.wires.filter((w) => w.cutBy === p.id).length,
    }))
    .sort((a, b) => b.cuts - a.cuts);

  return (
    <main className="relative min-h-dvh scanlines">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-1"
        style={{
          background: won ? "var(--signal-green)" : "var(--signal-red)",
          boxShadow: `0 0 16px ${
            won ? "var(--signal-green)" : "var(--signal-red)"
          }`,
        }}
      />

      <div className="mx-auto max-w-md px-5 pb-10 pt-8">
        <p className="label">Room {game.code} · Round over</p>

        <h1
          className="display mt-2 flex items-center gap-3 text-6xl uppercase leading-none"
          style={{ color: won ? "var(--signal-green)" : "var(--signal-red)" }}
        >
          {won ? <Trophy size={44} /> : <Flame size={44} />}
          {won ? "Defused" : "Detonated"}
        </h1>

        <p className="mt-3 text-lg" style={{ color: "var(--cream-dim)" }}>
          {won
            ? `Well played, ${playerName}! Five out of five.`
            : `The clock won, ${playerName}. Next time.`}
        </p>

        {/* The personal line — the reason this lives on a phone and not a wall. */}
        <section className="panel mt-6 p-5">
          <p className="label mb-1 flex items-center gap-1.5"><Scissors size={11} />You cut</p>
          <p
            className="display text-5xl leading-none"
            style={{ color: seatColor }}
          >
            {cutByMe}
            <span className="text-2xl" style={{ color: "var(--cream-faint)" }}>
              {" "}
              / {cutTotal} wires
            </span>
          </p>
          {cutByMe === 0 && (
            <p className="mt-2 text-xs" style={{ color: "var(--cream-faint)" }}>
              No matter — the team's work was the team's.
            </p>
          )}
        </section>

        <section className="mt-3 grid grid-cols-2 gap-3">
          <Stat
            icon={<Clock size={11} />}
            label={won ? "Left" : "Elapsed"}
            value={formatClock(game.secondsLeft)}
          />
          <Stat icon={<Lightbulb size={11} />} label="Hints" value={String(game.hintsUsed)} />
          <Stat icon={<XCircle size={11} />} label="Wrong" value={String(game.wrongAnswers)} />
          <Stat
            icon={<PhoneCall size={11} />}
            label="Lifeline"
            value={game.lifeline.used ? "Used" : "Unused"}
          />
        </section>

        {!won && remaining.length > 0 && (
          <section className="panel mt-3 p-4">
            <p className="label mb-2">These wires were left</p>
            <div className="flex flex-wrap gap-2">
              {remaining.map((w) => (
                <span
                  key={w.color}
                  className="border px-2.5 py-1 text-sm"
                  style={{ borderColor: WIRE_HEX[w.color as WireColor] }}
                >
                  {WIRE_LABELS_EN[w.color as WireColor]}
                </span>
              ))}
            </div>
          </section>
        )}

        {game.players.length > 1 && (
          <section className="panel mt-3 p-4">
            <p className="label mb-3 flex items-center gap-1.5"><Users size={11} />Scoreboard</p>
            <div className="space-y-2">
              {board.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <span
                    className="block size-2.5 shrink-0"
                    style={{ background: p.color }}
                  />
                  <span
                    className="display text-xl uppercase leading-none"
                    style={{
                      color:
                        p.id === playerId ? "var(--cream)" : "var(--cream-dim)",
                    }}
                  >
                    {p.name}
                    {p.id === playerId && <span className="label ml-2">you</span>}
                  </span>
                  <span
                    className="numerals ml-auto text-xl"
                    style={{
                      color: p.cuts > 0 ? p.color : "var(--cream-faint)",
                    }}
                  >
                    {p.cuts}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <a
          href="/"
          className="btn btn-brass mt-6 flex w-full items-center justify-center gap-2 py-4"
        >
          <Home size={16} />
          Main menu
        </a>

        <p
          className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs"
          style={{ color: "var(--cream-faint)" }}
        >
          <MicOff size={12} />
          Number delete ho gaya · mic band
        </p>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="panel p-4">
      <p className="label-dim mb-1 flex items-center gap-1.5">
        {icon}
        {label}
      </p>
      <p className="numerals text-2xl leading-none">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

const WIRE_HEX: Record<WireColor, string> = {
  red: "#e5484d",
  blue: "#4a9eff",
  yellow: "#f5c542",
  green: "#3dd68c",
  white: "#e8e2d6",
};

/**
 * A wire, not a dot.
 *
 * Cut renders as two stubs with a real gap, because "there is a hole where the
 * wire was" is legible at a glance in a way a greyed-out circle is not.
 */
function WirePip({
  color,
  status,
  active,
}: {
  color: WireColor;
  status: string;
  active: boolean;
}) {
  const hex = WIRE_HEX[color];
  const cut = status === "cut";
  const deferred = status === "deferred";

  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <div className="relative flex h-10 w-full items-center justify-center">
        {cut ? (
          <>
            <span
              className="absolute top-0 h-3.5 w-1.5"
              style={{ background: hex, opacity: 0.55 }}
            />
            <span
              className="absolute bottom-0 h-3.5 w-1.5 rotate-6"
              style={{ background: hex, opacity: 0.55 }}
            />
          </>
        ) : (
          <span
            className="h-full w-1.5"
            style={{
              background: hex,
              opacity: deferred ? 0.3 : 1,
              boxShadow: active ? `0 0 10px ${hex}` : "none",
            }}
          />
        )}
      </div>
      <span
        className="label-dim"
        style={{ color: active ? hex : undefined, fontSize: "0.5rem" }}
      >
        {cut ? "cut" : deferred ? "later" : WIRE_LABELS_EN[color].slice(0, 4)}
      </span>
    </div>
  );
}

/** The riddle text for the active wire, in Roman for reading at arm's length. */
function ActiveRiddle({ code, wire }: { code: string; wire: WireColor }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/room/${code}/riddle?wire=${wire}`)
      .then((r) => r.json())
      .then((d) => alive && setText(d.screen ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, wire]);

  return <>{text ?? "…"}</>;
}

/**
 * Hold-to-talk, kept as a momentary override on top of latched Peer Talk.
 *
 * Peer Talk is right for a twenty-second argument. This is for the one
 * utterance that must not be misattributed — the final "lock kiya jaye".
 */
function HoldToTalk({
  code,
  playerId,
  disabled,
}: {
  code: string;
  playerId: string;
  disabled: boolean;
}) {
  const [held, setHeld] = useState(false);
  const sent = useRef(false);

  const send = (holding: boolean) => {
    if (sent.current === holding) return;
    sent.current = holding;
    void fetch(`/api/room/${code}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "hold", playerId, holding }),
    });
  };

  return (
    <button
      disabled={disabled}
      onPointerDown={() => {
        setHeld(true);
        send(true);
      }}
      onPointerUp={() => {
        setHeld(false);
        send(false);
      }}
      onPointerLeave={() => {
        if (!held) return;
        setHeld(false);
        send(false);
      }}
      className="panel flex flex-col items-center justify-center gap-1.5 p-3 text-center transition-colors disabled:opacity-40"
      style={{
        borderColor: held ? "var(--brass)" : undefined,
        background: held
          ? "color-mix(in srgb, var(--brass) 14%, var(--ink-raised))"
          : undefined,
      }}
    >
      <Hand size={22} style={{ color: held ? "var(--brass)" : "var(--cream-faint)" }} />
      <span className="display text-lg uppercase leading-none">
        {held ? "Bolo" : "Dabao"}
      </span>
      <span className="text-[0.65rem] leading-tight" style={{ color: "var(--cream-faint)" }}>
        Hold to talk
      </span>
    </button>
  );
}

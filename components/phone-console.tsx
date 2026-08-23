"use client";

import { useEffect, useRef, useState } from "react";
import { useRoom, formatClock } from "@/lib/use-room";
import { useAgora, configuredMode, type AgoraCredentials } from "@/lib/use-agora";
import { SEAT_COLORS, WIRE_LABELS_HI, type WireColor } from "@/lib/game/state";

/**
 * The contestant's handset — spec §4, plus Peer Talk.
 *
 * Deliberately sparse. Their eyes belong on the big screen and on each other;
 * this is a control surface they operate by feel while looking somewhere else.
 * So: few controls, all large, and the one that matters is unmissable.
 *
 * No WebGL here. Three phones running WebRTC with open mics is already the
 * fragile part of the system, and a spinning canvas on each of them buys nothing
 * — the 3D lives on the projector, which is what the room is actually watching.
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

  /** Indian mobile: ten digits, ignoring spaces, dashes and a leading +91. */
  const digits = phone.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  const phoneOk = digits.length === 10;
  const nameOk = name.trim().length > 0;
  const ready = nameOk && phoneOk && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/room/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The number is required now, so entering it *is* the consent — the
        // notice below the field says so in as many words.
        body: JSON.stringify({ name, phone: digits, consent: true }),
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
          <h1 className="display mt-2 text-5xl uppercase">
            Kaun Katega
            <br />
            <span style={{ color: "var(--brass)" }}>Taarpati</span>
          </h1>
          <p className="mt-3 text-sm" style={{ color: "var(--cream-dim)" }}>
            Paanch taar. Chhe minute. Aap contestant hain.
          </p>
        </header>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className="label-dim mb-2 block" htmlFor="name">
              Aapka naam
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
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
                : "Sirf Phone a Friend ke liye. Game khatam hote hi delete ho jaata hai — save nahi hota, kisi ko diya nahi jaata."}
            </p>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "var(--signal-red)" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!ready}
            className="btn btn-brass w-full py-4 text-base"
          >
            {busy ? "Baith rahe hain…" : "Seat le lo"}
          </button>

          <p
            className="text-center text-xs"
            style={{ color: "var(--cream-faint)" }}
          >
            Mic ki permission maangi jayegi. Deni padegi — game bolne se chalta hai.
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
  const { game, connected, act } = useRoom(code);
  const [peerMode, setPeerMode] = useState(true);
  const [pending, setPending] = useState(false);

  const lifelineSpent = game?.lifeline.used ?? false;
  const lifelineActive = game?.lifeline.activeFor === session.player.id;
  const requestedByMe = game?.lifeline.requestedBy === session.player.id;
  const requestedBySomeone = Boolean(game?.lifeline.requestedBy);
  const roundOver = game?.phase === "won" || game?.phase === "lost";

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
  const live = !peerMode && !lifelineActive && !roundOver;

  /** Keep the server's view of who is live in step with the local toggle. */
  async function togglePeer() {
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
   * Duck our own capture while the host is talking.
   *
   * Driven off the host's measured level rather than a server event, because
   * the leak we are fighting is acoustic and arrives with the audio.
   */
  useEffect(() => {
    agora.duck(agora.agentLevel > 0.06);
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
  async function askForLifeline() {
    if (lifelineSpent || roundOver) return;
    try {
      await act(
        requestedByMe
          ? { type: "cancel_lifeline" }
          : { type: "request_lifeline", playerId: session.player.id },
      );
    } catch {
      // The host can still offer it verbally; nothing is lost.
    }
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

      <div className="mx-auto max-w-md px-5 pb-8 pt-6">
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
              <span
                className={`lamp ${connected ? "lamp-on lamp-green" : "lamp-on lamp-red"}`}
              />
              <span className="label-dim">
                {connected ? "linked" : "reconnecting"}
              </span>
            </div>
          </div>
        </div>

        {/* -- wires ------------------------------------------------------- */}
        <section className="mt-6">
          <p className="label mb-2">Taar</p>
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
          <p className="label mb-2">
            {game?.activeWire
              ? `Sawaal — ${WIRE_LABELS_HI[game.activeWire as WireColor]} taar`
              : "Sawaal"}
          </p>
          <div className="panel-sunken min-h-24 p-4">
            <p className="text-lg leading-snug">
              {game?.activeWire ? (
                <ActiveRiddle code={code} wire={game.activeWire as WireColor} />
              ) : (
                <span style={{ color: "var(--cream-faint)" }}>
                  Amitabh bhai se bolo kis taar se shuru karna hai.
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
                        : "Peer talk"}
                </span>
                <span className="mt-1 block text-sm opacity-80">
                  {lifelineActive
                    ? "Call chal rahi hai — phone kaan pe rakho"
                    : roundOver
                      ? "Round poora ho gaya"
                      : live
                        ? "Amitabh bhai sun rahe hain"
                        : "Aap teeno baat kar sakte ho — host nahi sun raha"}
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
              ? "Jo suna wo baad mein sabko batao"
              : roundOver
                ? "Screen dekho"
                : live
                  ? "Tap karke wapas discussion mein jao"
                  : "Jawab dene ke liye tap karo · discussion free hai"}
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
            className="panel flex flex-col items-center justify-center gap-1 p-3 text-center transition-colors disabled:opacity-45"
            style={{
              borderColor: lifelineActive
                ? "var(--signal-amber)"
                : requestedByMe
                  ? "var(--brass)"
                  : undefined,
              background: requestedByMe
                ? "color-mix(in srgb, var(--brass) 14%, var(--ink-raised))"
                : undefined,
            }}
          >
            <span className="label">Phone a friend</span>
            <span className="display text-xl uppercase">
              {lifelineActive
                ? "On call"
                : lifelineSpent
                  ? "Spent"
                  : requestedByMe
                    ? "Poocha hai"
                    : requestedBySomeone
                      ? "Maanga gaya"
                      : "Maango"}
            </span>
            <span className="text-xs" style={{ color: "var(--cream-faint)" }}>
              {lifelineActive
                ? "Mic band hai"
                : lifelineSpent
                  ? "Ho chuka"
                  : requestedByMe
                    ? "Tap to cancel"
                    : session.player.hasPhone
                      ? "45 second lagenge"
                      : "Number nahi diya"}
            </span>
          </button>
        </section>

        {/* Who else the host can hear — makes contested states legible. */}
        <section className="mt-6">
          <p className="label mb-2">Kaun on air hai</p>
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
        {cut ? "kat" : deferred ? "baad" : WIRE_LABELS_HI[color].slice(0, 4)}
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
      className="panel flex flex-col items-center justify-center gap-1 p-3 text-center transition-colors disabled:opacity-40"
      style={{
        borderColor: held ? "var(--brass)" : undefined,
        background: held
          ? "color-mix(in srgb, var(--brass) 14%, var(--ink-raised))"
          : undefined,
      }}
    >
      <span className="label">Hold to talk</span>
      <span className="display text-xl uppercase">
        {held ? "Bolo" : "Dabao"}
      </span>
      <span className="text-xs" style={{ color: "var(--cream-faint)" }}>
        Pakka attribution
      </span>
    </button>
  );
}

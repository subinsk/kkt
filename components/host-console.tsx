"use client";

import { useEffect, useState } from "react";
import { useRoom, formatClock } from "@/lib/use-room";
import { RoomGone } from "@/components/room-gone";
import { StageCanvas } from "@/components/stage/stage-canvas";
import { useAgora, type AgoraCredentials } from "@/lib/use-agora";
import { WIRE_COLORS, WIRE_LABELS_EN, type WireColor } from "@/lib/game/state";

/**
 * The host console — spec §11.
 *
 * Two jobs. It satisfies "host or user control where relevant", and — much more
 * importantly — it is the insurance policy for when something misfires in front
 * of judges. Semantic judging too strict? Force-cut. Attribution named the wrong
 * person? Force-attribute. Someone needs thirty seconds to explain the safety
 * model? Pause.
 *
 * Designed to be operated by someone who is *also* talking to an audience: dense
 * but flat, everything one click deep, nothing hidden behind a menu, and no
 * confirmation dialogs. A "are you sure?" here would cost the exact seconds it
 * exists to save.
 *
 * Deliberately unauthenticated. This runs on a laptop on a desk for six minutes.
 */

export default function HostConsole({ code }: { code: string }) {
  const { game, connected, missing, events, onEvent, act } = useRoom(code);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<AgoraCredentials | null>(null);
  const [minimal, setMinimal] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [hostSaid, setHostSaid] = useState<string | null>(null);

  /**
   * Join the channel as a monitor: subscribed, publishing nothing, playing
   * nothing. Purely so the preview's host figure reacts to his real voice.
   *
   * Playing audio here would be a bug, not a feature — the console normally
   * runs on the same laptop as the projector, so it would double the host in
   * the room.
   */
  const agora = useAgora({ role: "monitor", credentials });

  useEffect(() => {
    let alive = true;
    fetch(`/api/room/${code}/spectator`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && !d.error) setCredentials(d as AgoraCredentials);
      })
      .catch(() => {
        // The preview works fine without it; only the head-bob is lost.
      });
    return () => {
      alive = false;
    };
  }, [code]);

  /** Mirror the host's speech into the preview bubble. */
  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "host_said" || event.type === "agent_spoke") {
          setHostSaid(String(event.payload.text ?? ""));
        }
      }),
    [onEvent],
  );

  async function run(label: string, payload: Record<string, unknown>) {
    setBusy(label);
    setNote(null);
    try {
      await act(payload);
      setNote(`${label} ✓`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function agent(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setNote(null);
    try {
      const res = await fetch(`/api/room/${code}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      setNote(data.error ? data.error : `agent ${action} ✓`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  if (!game) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        {missing ? (
          <div>
            <p className="label" style={{ color: "var(--signal-red)" }}>
              No room {code}
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--cream-dim)" }}>
              Nothing is running under this code. Open a room first, then use the
              Host panel link on the projector.
            </p>
            <a href="/" className="btn mt-5 inline-block px-5 py-2.5">
              Main menu
            </a>
          </div>
        ) : (
          <p className="label">Connecting to room {code}…</p>
        )}
      </main>
    );
  }

  // The server has forgotten this room; everything below would be stale.
  if (missing) return <RoomGone code={code} />;

  const panic = game.secondsLeft <= 60 && game.phase === "running";

  return (
    <main className="min-h-dvh px-6 py-5">
      <div className="mx-auto max-w-6xl">
        {/* ------------------------------------------------------ header --- */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-4">
          <div>
            <p className="label">Host console · Room {code}</p>
            <h1 className="display text-3xl uppercase">
              Kaun Katega Taarpati
            </h1>
          </div>

          <div className="flex items-end gap-6">
            <div className="text-right">
              <p className="label-dim">Clock</p>
              <p
                className={`numerals text-5xl leading-none ${panic ? "panic" : ""}`}
              >
                {formatClock(game.secondsLeft)}
              </p>
            </div>
            <div className="text-right">
              <p className="label-dim">Phase</p>
              <p className="display text-2xl uppercase">
                {game.paused ? "paused" : game.phase}
              </p>
            </div>
            <div className="flex items-center gap-2 pb-1">
              <span
                className={`lamp lamp-on ${connected ? "lamp-green" : "lamp-red"}`}
              />
              <span className="label-dim">
                {connected ? "linked" : "reconnecting"}
              </span>
            </div>
          </div>
        </header>

        {note && (
          <p
            className="mt-3 text-sm"
            style={{ color: "var(--brass-bright)" }}
          >
            {note}
          </p>
        )}

        {/* ---------------------------------------------------- viewport --- */}
        {/**
         * The same 3D scene the projector shows, at the top of the console.
         *
         * Not decoration. The operator has to see what the audience sees to
         * make any of the calls this panel exists for — did that force-cut
         * actually land, is the right seat lit, is the host looking at the
         * person who spoke. Alt-tabbing to the projector to check would cost
         * exactly the seconds the console is here to save.
         */}
        <section className="panel mt-5 overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <p className="label">Programme feed</p>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span
                  className={`lamp ${
                    agora.agentPresent ? "lamp-on lamp-green" : "lamp-on lamp-amber"
                  }`}
                />
                <span className="label-dim">
                  {agora.agentPresent ? "host live" : "host absent"}
                </span>
              </div>
              <button
                className="label-dim hover:text-[var(--brass)]"
                onClick={() => setResetToken((n) => n + 1)}
                title="Drag to orbit · scroll to zoom · right-drag to pan"
              >
                Reset camera
              </button>
              <button
                className="label-dim hover:text-[var(--brass)]"
                onClick={() => setMinimal((m) => !m)}
                title="Strip shadows and particles if the framerate suffers"
              >
                {minimal ? "Simple view ✓" : "Simple view"}
              </button>
            </div>
          </div>

          <div className="relative aspect-[21/9] w-full bg-[var(--ink-sunken)]">
            <StageCanvas
              game={game}
              agentLevelRef={agora.agentLevelRef}
              minimal={minimal}
              interactive
              resetToken={resetToken}
              hostSaid={hostSaid}
              className="absolute inset-0"
            />

            {/* A compact mirror of the broadcast overlay, so the console reads
                the same as the big screen at a glance. */}
            <div className="pointer-events-none absolute inset-0 vignette">
              <p
                className={`numerals absolute right-4 top-3 text-4xl leading-none ${
                  panic ? "panic" : ""
                }`}
                style={{
                  color:
                    game.phase === "won" ? "var(--signal-green)" : undefined,
                }}
              >
                {formatClock(game.secondsLeft)}
              </p>

              <div className="absolute bottom-3 left-4 flex gap-3">
                {game.players.map((p) => {
                  const live = game.live.includes(p.id);
                  return (
                    <span
                      key={p.id}
                      className="flex items-center gap-1.5 text-sm"
                      style={{
                        color: live ? "var(--cream)" : "var(--cream-faint)",
                      }}
                    >
                      <span
                        className={`lamp ${live ? "lamp-on" : ""}`}
                        style={live ? { background: p.color } : undefined}
                      />
                      {p.name}
                    </span>
                  );
                })}
              </div>

              {(game.phase === "won" || game.phase === "lost") && (
                <p
                  className="display absolute inset-0 grid place-items-center text-6xl uppercase"
                  style={{
                    color:
                      game.phase === "won"
                        ? "var(--signal-green)"
                        : "var(--signal-red)",
                  }}
                >
                  {game.phase === "won" ? "Defused" : "Phat gaya"}
                </p>
              )}
            </div>
          </div>
        </section>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr_320px]">
          {/* ---------------------------------------------------- clock --- */}
          <section className="panel p-4">
            <p className="label mb-3">Clock</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn"
                disabled={busy !== null || game.phase !== "running"}
                onClick={() => run("pause", { type: "pause" })}
              >
                Pause
              </button>
              <button
                className="btn"
                disabled={busy !== null || !game.paused}
                onClick={() => run("resume", { type: "resume" })}
              >
                Resume
              </button>
            </div>

            <p className="label-dim mt-4 mb-2">Refund / burn</p>
            <div className="grid grid-cols-4 gap-2">
              {[15, 30, 45].map((s) => (
                <button
                  key={s}
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    run(`+${s}s`, {
                      type: "adjust_clock",
                      seconds: s,
                      reason: "host refund",
                    })
                  }
                >
                  +{s}
                </button>
              ))}
              <button
                className="btn btn-danger"
                disabled={busy !== null}
                onClick={() =>
                  run("−20s", {
                    type: "adjust_clock",
                    seconds: -20,
                    reason: "host penalty",
                  })
                }
              >
                −20
              </button>
            </div>

            <p className="label-dim mt-4 mb-2">Round</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn"
                disabled={busy !== null || game.phase !== "lobby"}
                onClick={() => run("start", { type: "start" })}
              >
                Start
              </button>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() => run("reset", { type: "reset" })}
              >
                Reset round
              </button>
              <button
                className="btn btn-danger"
                disabled={busy !== null}
                onClick={() =>
                  run("force win", { type: "end_round", outcome: "won", reason: "host" })
                }
              >
                Force win
              </button>
              <button
                className="btn btn-danger"
                disabled={busy !== null}
                onClick={() =>
                  run("force loss", { type: "end_round", outcome: "lost", reason: "host" })
                }
              >
                Force loss
              </button>
            </div>
          </section>

          {/* ---------------------------------------------------- wires --- */}
          <section className="panel p-4">
            <p className="label mb-3">Wires</p>
            <div className="space-y-2">
              {WIRE_COLORS.map((color) => {
                const wire = game.wires.find((w) => w.color === color);
                const cut = wire?.status === "cut";
                const active = game.activeWire === color;
                return (
                  <div
                    key={color}
                    className="flex items-center gap-2 border p-2"
                    style={{
                      borderColor: active ? "var(--brass)" : "var(--rule)",
                    }}
                  >
                    <span
                      className="block h-6 w-1.5 shrink-0"
                      style={{
                        background: WIRE_HEX[color],
                        opacity: cut ? 0.3 : 1,
                      }}
                    />
                    <span className="display w-16 shrink-0 text-lg uppercase">
                      {WIRE_LABELS_EN[color]}
                    </span>
                    <span
                      className="label-dim w-14 shrink-0"
                      style={{
                        color: cut ? "var(--signal-green)" : undefined,
                      }}
                    >
                      {wire?.status ?? "—"}
                    </span>
                    <div className="ml-auto flex gap-1.5">
                      <button
                        className="btn px-2 py-1 text-[0.7rem]"
                        disabled={busy !== null || cut}
                        onClick={() =>
                          run(`select ${color}`, {
                            type: "select_wire",
                            color,
                          })
                        }
                      >
                        Select
                      </button>
                      <button
                        className="btn px-2 py-1 text-[0.7rem]"
                        disabled={busy !== null || cut}
                        onClick={() =>
                          run(`defer ${color}`, { type: "defer_wire", color })
                        }
                      >
                        Defer
                      </button>
                      <button
                        className="btn btn-brass px-2 py-1 text-[0.7rem]"
                        disabled={busy !== null || cut}
                        onClick={() =>
                          run(`cut ${color}`, {
                            type: "force_cut",
                            color,
                            playerId: game.lastSpeaker ?? undefined,
                          })
                        }
                      >
                        Cut
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p
              className="mt-3 text-xs"
              style={{ color: "var(--cream-faint)" }}
            >
              Cut credits whoever spoke last.
            </p>
          </section>

          {/* ----------------------------------------------- right rail --- */}
          <div className="space-y-5">
            {/* --------------------------------------------- agent ------- */}
            <section className="panel p-4">
              <p className="label mb-3">Amitabh bhai</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => agent("start")}
                >
                  Start
                </button>
                <button
                  className="btn btn-danger"
                  disabled={busy !== null}
                  onClick={() => agent("stop")}
                >
                  Kill
                </button>
                <button
                  className="btn col-span-2"
                  disabled={busy !== null}
                  onClick={() => agent("interrupt")}
                >
                  Interrupt
                </button>
              </div>
              <SpeakBox onSpeak={(text) => agent("speak", { text })} />
            </section>

            {/* ---------------------------------------- contestants ------ */}
            <section className="panel p-4">
              <p className="label mb-3">Contestants</p>
              {game.players.length === 0 && (
                <p className="text-sm" style={{ color: "var(--cream-faint)" }}>
                  Nobody has joined.
                </p>
              )}
              <div className="space-y-2">
                {game.players.map((p) => {
                  const live = game.live.includes(p.id);
                  const speaking = game.lastSpeaker === p.id;
                  return (
                    <div key={p.id} className="border p-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`lamp ${live ? "lamp-on" : ""}`}
                          style={live ? { background: p.color } : undefined}
                        />
                        <span className="display text-lg uppercase">
                          {p.name}
                        </span>
                        {speaking && (
                          <span className="label" style={{ color: p.color }}>
                            speaking
                          </span>
                        )}
                        {!p.connected && (
                          <span className="label-dim">offline</span>
                        )}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          className="btn flex-1 px-2 py-1 text-[0.7rem]"
                          disabled={busy !== null}
                          onClick={() =>
                            run(`attribute ${p.name}`, {
                              type: "force_attribute",
                              playerId: p.id,
                            })
                          }
                        >
                          It was them
                        </button>
                        <button
                          className="btn flex-1 px-2 py-1 text-[0.7rem]"
                          disabled={busy !== null}
                          onClick={() =>
                            run(`${p.name} ${live ? "→ peer" : "→ live"}`, {
                              type: "peer_mode",
                              playerId: p.id,
                              peerMode: live,
                            })
                          }
                        >
                          {live ? "Mute to host" : "Go live"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    run("all peer", { type: "all_peer_mode", peerMode: true })
                  }
                >
                  All → peer
                </button>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    run("all live", { type: "all_peer_mode", peerMode: false })
                  }
                >
                  All → live
                </button>
              </div>
            </section>

            {/* ------------------------------------------ lifeline ------- */}
            <section
              className="panel p-4"
              style={{
                borderColor: game.lifeline.requestedBy
                  ? "var(--signal-amber)"
                  : undefined,
              }}
            >
              <p className="label mb-2">Phone a friend</p>
              <p className="display text-2xl uppercase">
                {game.lifeline.status}
              </p>
              <p className="text-xs" style={{ color: "var(--cream-faint)" }}>
                {game.lifeline.used
                  ? game.lifeline.activeFor
                    ? "Live now — that handset is muted"
                    : "Spent"
                  : "Available"}
              </p>

              {/**
               * A contestant has asked and the host has not acted yet.
               *
               * Normally the host offers the trade and the LLM fires the tool
               * off a spoken yes. This is the manual path for when he misses the
               * request or the room is too loud for him to hear the answer.
               */}
              {game.lifeline.requestedBy && (
                <div className="mt-3 border-t pt-3">
                  <p className="label-dim mb-2">
                    {game.players.find((p) => p.id === game.lifeline.requestedBy)
                      ?.name ?? "Someone"}{" "}
                    asked for it
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      className="btn btn-brass px-2 py-1 text-[0.7rem]"
                      disabled={busy !== null}
                      onClick={() =>
                        run("grant lifeline", {
                          type: "grant_lifeline",
                          playerId: game.lifeline.requestedBy ?? undefined,
                        })
                      }
                    >
                      Unlock it
                    </button>
                    <button
                      className="btn px-2 py-1 text-[0.7rem]"
                      disabled={busy !== null}
                      onClick={() =>
                        run("cancel lifeline", { type: "cancel_lifeline" })
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>

        {/* ------------------------------------------------------- log --- */}
        <section className="panel mt-5 p-4">
          <p className="label mb-3">Event log</p>
          <div className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
            {events.length === 0 && (
              <p style={{ color: "var(--cream-faint)" }}>Nothing yet.</p>
            )}
            {events.map((e) => (
              <div key={e.seq} className="flex gap-3">
                <span style={{ color: "var(--cream-faint)" }}>
                  {String(e.seq).padStart(3, "0")}
                </span>
                <span style={{ color: "var(--brass)" }} className="w-44 shrink-0">
                  {e.type.replace(/_/g, " ")}
                </span>
                <span
                  className="truncate"
                  style={{ color: "var(--cream-dim)" }}
                >
                  {summarise(e.payload)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * The log is scanned at a glance by someone who is also talking to a room, so
 * the payload renders as `key value` pairs. Braces and quote marks are noise at
 * that reading speed, and nested objects are never the thing being looked for.
 */
function summarise(payload: Record<string, unknown>): string {
  return Object.entries(payload ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => (typeof v === "object" ? k : `${k} ${String(v)}`))
    .join("  ·  ");
}

const WIRE_HEX: Record<WireColor, string> = {
  red: "#e5484d",
  blue: "#4a9eff",
  yellow: "#f5c542",
  green: "#3dd68c",
  white: "#e8e2d6",
};

/**
 * Put an exact sentence in the host's mouth.
 *
 * The escape hatch for a moment the model will not produce on its own: covering
 * an awkward silence, or delivering a line the demo script needs verbatim.
 */
function SpeakBox({ onSpeak }: { onSpeak: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSpeak(text.trim());
        setText("");
      }}
    >
      <p className="label-dim mb-1.5">Make him say</p>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Lock kiya jaye?"
        className="panel-sunken w-full px-3 py-2 text-sm outline-none focus:border-[var(--brass)]"
      />
    </form>
  );
}

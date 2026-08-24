"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import { RulesDialog } from "@/components/landing/rules-dialog";

/**
 * The front door, and it has exactly one job: open a room.
 *
 * Opening one sends the host straight to the projector, which is where the
 * room code and the join QR live and where the game is actually started. There
 * is deliberately no menu of views here — a host picking between three links
 * before a show is a decision they should never have been handed. Contestants
 * arrive by scanning; the operator's panel is at `/host/<code>` for whoever
 * needs it.
 *
 * All copy on this page is English, the app's own name aside. The Hinglish is
 * the *show* — it belongs to the host's voice and to the riddles, not to the
 * signage a stranger reads while deciding whether to press the button.
 *
 * Nothing diagnostic renders on this page. The pre-flight check lives at
 * `/api/health`, which is where it belongs — this screen is seen by people who
 * are about to play.
 */

/**
 * three.js is the heaviest thing on this route and nothing above the fold needs
 * it, so it loads on the client after the copy is already readable.
 */
const HeroCanvas = dynamic(() => import("@/components/landing/hero-canvas"), {
  ssr: false,
});

export default function HomePage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  /**
   * Open a room the operator already has a code for.
   *
   * `POST /api/room` with a code is idempotent: it reuses the room if one
   * exists and opens it if not. So this both rejoins a live room and resurrects
   * one the server forgot on restart.
   *
   * Read from the ref rather than state — this field gets pasted into, and a
   * paste does not always fire onChange.
   */
  async function openByCode(e: React.FormEvent) {
    e.preventDefault();
    const clean = (codeRef.current?.value ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);

    if (clean.length < 3) {
      setError("Enter the full room code.");
      codeRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await fetch("/api/room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: clean }),
      });
      router.push(`/stage/${clean}`);
    } catch {
      // Navigate anyway — the stage and join routes both open a missing room.
      router.push(`/stage/${clean}`);
    }
  }

  async function openRoom() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/room", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.code) {
        throw new Error(data.error ?? "Could not open a room.");
      }
      router.push(`/stage/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a room.");
      // Only release the button on failure. On success the route is already
      // changing, and a button that springs back to life mid-navigation invites
      // a second room nobody wanted.
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-[var(--ink)]">
      {/* The set itself, behind everything — the same room the projector shows. */}
      <div className="absolute inset-0">
        <HeroCanvas />
      </div>

      {/**
       * Scrim.
       *
       * Only as dark as the text above it needs, and no darker — the animation
       * is the page's one argument for what the show is, and a scrim heavy
       * enough to be safe everywhere renders it as vague brown movement.
       *
       * So it is shaped to the copy rather than spread over the frame. Portrait
       * bands to the bottom, where the column sits, leaving the top of the
       * screen clear for the room. Landscape holds opaque across the left
       * column and then falls off fast, because the host sits dead centre and a
       * scrim that reaches him is a scrim covering the one face on the page.
       */}
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(6,5,4,0)_0%,rgba(6,5,4,0.12)_22%,rgba(6,5,4,0.66)_44%,rgba(6,5,4,0.94)_100%)] md:bg-[linear-gradient(90deg,rgba(6,5,4,0.94)_0%,rgba(6,5,4,0.9)_28%,rgba(6,5,4,0.55)_43%,rgba(6,5,4,0)_62%)]"
      />
      {/* Shallower than the rest of the app. The set is already carrying the
          projector's own vignette from inside the canvas; stacking the full
          strength on top crushes the corners of the room. */}
      <div
        className="vignette scanlines pointer-events-none absolute inset-0"
        style={{ "--vignette-edge": "0.26" } as React.CSSProperties}
      />

      {/**
       * The copy column spans the viewport, so it has to let pointer events
       * fall through to the canvas underneath — otherwise the hero's parallax
       * would only respond in the margins beside it. Only the controls opt back
       * in.
       *
       * Bottom-aligned on a phone and centred once there is width: on a handset
       * the copy gives up the top of the screen so the room is visible above it
       * rather than behind it.
       */}
      <div className="pointer-events-none relative mx-auto flex min-h-dvh max-w-6xl items-end px-6 py-12 md:items-center md:py-16">
        <div className="w-full max-w-md">
          {/**
           * The wordmark, and it is a real `h1` — the name lives in the `alt`,
           * which is what a crawler and a screen reader both read. Setting the
           * lockup as live text instead would mean rebuilding the cut wire that
           * runs through TAARPATI, and that wire is the whole idea.
           *
           * `priority` because this is the largest thing above the fold on a
           * phone and therefore the LCP element. Left lazy it would arrive
           * after the three.js set, which is the wrong order.
           */}
          <h1 className="w-full max-w-[19rem] sm:max-w-[23rem]">
            <Image
              src="/kkt-logo.png"
              alt="Kaun Katega Taarpati"
              width={1104}
              height={678}
              priority
              className="h-auto w-full"
            />
          </h1>

          <p
            className="mt-5 text-lg leading-snug sm:text-xl"
            style={{ color: "var(--cream-dim)" }}
          >
            Five wires. Six minutes. Answer the riddles to cut them all — or the
            confetti charge goes off. Amitabh ji is already inside, waiting to
            ask.
          </p>

          <button
            onClick={openRoom}
            disabled={busy}
            className="btn btn-brass pointer-events-auto mt-8 w-full py-5 text-base"
          >
            {busy ? "Opening room…" : "Open a new room"}
          </button>

          {error && (
            <p className="mt-3 text-sm" style={{ color: "var(--signal-red)" }}>
              {error}
            </p>
          )}

          {/**
           * Reopen a room by code.
           *
           * Rooms live in memory, so a server restart — or a projector reload
           * after a crash — leaves three contestants holding phones that still
           * show a code the server has forgotten. Typing it back in re-creates
           * that exact room instead of minting a new code nobody has seen.
           *
           * `pointer-events-auto`, because the column above it deliberately lets
           * clicks fall through to the canvas.
           */}
          <form onSubmit={openByCode} className="pointer-events-auto mt-6">
            <label className="label-dim mb-2 block" htmlFor="code">
              Or reopen an existing room
            </label>
            <div className="flex gap-2">
              <input
                id="code"
                ref={codeRef}
                maxLength={8}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="DEMO"
                className="panel-sunken numerals w-full px-4 py-3 text-2xl uppercase tracking-[0.25em] outline-none focus:border-[var(--brass)]"
              />
              <button type="submit" className="btn shrink-0 px-5">
                Open
              </button>
            </div>
          </form>

          {/**
           * The rules live behind a link, not on the page.
           *
           * Someone about to host has one decision here and it is the brass
           * button. Anyone who actually wants the penalty table is looking for
           * it, and a modal is a cheaper thing to open than a route change that
           * would tear down the hero and re-mount three.js on the way back.
           */}
          <button
            onClick={() => setRulesOpen(true)}
            className="pointer-events-auto mt-6 text-sm underline decoration-[var(--brass-dim)] decoration-1 underline-offset-4 transition-colors hover:text-[var(--brass-bright)] hover:decoration-[var(--brass)]"
            style={{ color: "var(--brass)" }}
          >
            Game rules
          </button>
        </div>
      </div>

      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </main>
  );
}

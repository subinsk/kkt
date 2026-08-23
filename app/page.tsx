"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";

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

  async function openRoom() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/room", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.code) {
        throw new Error(data.error ?? "Room nahi khula");
      }
      router.push(`/stage/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Room nahi khula");
      // Only release the button on failure. On success the route is already
      // changing, and a button that springs back to life mid-navigation invites
      // a second room nobody wanted.
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-[var(--ink)]">
      {/* The set piece, behind everything. */}
      <div className="absolute inset-0">
        <HeroCanvas />
      </div>

      {/* Scrim: bottom-weighted on a phone, left-weighted once there is room
          beside the object for the copy to sit. */}
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(6,5,4,0.45)_0%,rgba(6,5,4,0.72)_48%,rgba(6,5,4,0.95)_100%)] md:bg-[linear-gradient(90deg,rgba(6,5,4,0.95)_0%,rgba(6,5,4,0.8)_38%,rgba(6,5,4,0)_82%)]"
      />
      <div className="vignette scanlines pointer-events-none absolute inset-0" />

      {/**
       * The copy column spans the viewport, so it has to let pointer events
       * fall through to the canvas underneath — otherwise the hero's parallax
       * would only respond in the margins beside it. Only the button opts back
       * in.
       */}
      <div className="pointer-events-none relative mx-auto flex min-h-dvh max-w-6xl items-center px-6 py-16">
        <div className="w-full max-w-md">
          <p className="label">Kaun Katega</p>
          <h1 className="display mt-1 text-6xl uppercase leading-none sm:text-7xl">
            Taar<span style={{ color: "var(--brass)" }}>pati</span>
          </h1>

          <p
            className="mt-5 text-lg leading-snug sm:text-xl"
            style={{ color: "var(--cream-dim)" }}
          >
            Paanch taar. Chhe minute. Ek galat taar sab kuch uda degi.
            <br />
            Lock kiya jaye?
          </p>

          <button
            onClick={openRoom}
            disabled={busy}
            className="btn btn-brass pointer-events-auto mt-8 w-full py-5 text-base"
          >
            {busy ? "Room khol rahe hain…" : "Naya room kholo"}
          </button>

          {error && (
            <p className="mt-3 text-sm" style={{ color: "var(--signal-red)" }}>
              {error}
            </p>
          )}

          <p
            className="mt-5 text-sm leading-relaxed"
            style={{ color: "var(--cream-faint)" }}
          >
            Bade screen par room ka QR aayega. Contestants phone se scan karke
            baith jaate hain, phir game shuru.
          </p>
        </div>
      </div>
    </main>
  );
}

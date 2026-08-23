"use client";

import { useEffect, useState } from "react";

/**
 * The operator's landing page — not a contestant screen and not the projector.
 *
 * This is where you stand before the demo starts: it tells you whether the
 * build is actually ready to run, and it opens a room. Its whole job is to make
 * the silent failures loud before an audience is watching.
 */

type Health = {
  ready: boolean;
  blocking: string[];
  warnings: string[];
  llm: { provider: string; model: string };
  voice: { tts_speaker: string; asr_language: string };
  publicBaseUrl: string | null;
  liveRooms: { code: string; phase: string; players: number }[];
};

export default function HomePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  async function openRoom() {
    setBusy(true);
    try {
      const res = await fetch("/api/room", { method: "POST" });
      const data = await res.json();
      setCode(data.code ?? null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-10">
        <header className="space-y-2">
          <p className="font-mono text-xs tracking-[0.3em] text-amber-500">
            BUILD WITH AGORA · TRACK 4
          </p>
          <h1 className="text-4xl font-semibold tracking-tight">
            Kaun Katega Taarpati
          </h1>
          <p className="text-neutral-400">
            Paanch taar. Chhe minute. Lock kiya jaye?
          </p>
        </header>

        <section className="space-y-3">
          <button
            onClick={openRoom}
            disabled={busy}
            className="w-full rounded-lg bg-amber-500 px-5 py-3 font-medium text-neutral-950 transition hover:bg-amber-400 disabled:opacity-50"
          >
            {busy ? "Opening…" : "Open a room"}
          </button>

          {code && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
              <p className="text-xs uppercase tracking-widest text-neutral-500">
                Room code
              </p>
              <p className="font-mono text-5xl font-bold tracking-[0.2em] text-amber-400">
                {code}
              </p>
              <div className="mt-4 flex gap-3 text-sm">
                <a
                  className="rounded border border-neutral-700 px-3 py-1.5 hover:border-neutral-500"
                  href={`/stage/${code}`}
                >
                  Projector →
                </a>
                <a
                  className="rounded border border-neutral-700 px-3 py-1.5 hover:border-neutral-500"
                  href={`/join/${code}`}
                >
                  Phone →
                </a>
                <a
                  className="rounded border border-neutral-700 px-3 py-1.5 hover:border-neutral-500"
                  href={`/host/${code}`}
                >
                  Host console →
                </a>
              </div>
              <p className="mt-3 text-xs text-neutral-500">
                Projector and phone views land in the next phase.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-500">
            Pre-flight
          </h2>

          {!health && (
            <p className="text-sm text-neutral-500">Checking…</p>
          )}

          {health && (
            <div className="space-y-3">
              <div
                className={`rounded-lg border p-4 ${
                  health.ready
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-red-500/30 bg-red-500/5"
                }`}
              >
                <p className="font-medium">
                  {health.ready
                    ? "Ready to run."
                    : `${health.blocking.length} blocking issue${
                        health.blocking.length === 1 ? "" : "s"
                      }`}
                </p>
                <ul className="mt-2 space-y-1 text-sm text-neutral-300">
                  {health.blocking.map((b) => (
                    <li key={b}>· {b}</li>
                  ))}
                </ul>
              </div>

              {health.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
                  <p className="text-sm font-medium text-amber-300">
                    Warnings — these fail silently at runtime
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-neutral-300">
                    {health.warnings.map((w) => (
                      <li key={w}>· {w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-neutral-800 p-4 text-sm">
                <dt className="text-neutral-500">Brain</dt>
                <dd className="font-mono text-xs">{health.llm.model}</dd>
                <dt className="text-neutral-500">Host voice</dt>
                <dd className="font-mono text-xs">
                  sarvam · {health.voice.tts_speaker}
                </dd>
                <dt className="text-neutral-500">ASR language</dt>
                <dd className="font-mono text-xs">
                  {health.voice.asr_language}
                </dd>
                <dt className="text-neutral-500">Public origin</dt>
                <dd className="truncate font-mono text-xs">
                  {health.publicBaseUrl ?? "not set"}
                </dd>
              </dl>

              {health.liveRooms.length > 0 && (
                <div className="rounded-lg border border-neutral-800 p-4 text-sm">
                  <p className="mb-2 text-neutral-500">Live rooms</p>
                  {health.liveRooms.map((r) => (
                    <div key={r.code} className="flex justify-between font-mono text-xs">
                      <span className="text-amber-400">{r.code}</span>
                      <span className="text-neutral-400">
                        {r.phase} · {r.players} contestant
                        {r.players === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

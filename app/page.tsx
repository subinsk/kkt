"use client";

import { useState } from "react";

/**
 * The front door.
 *
 * One job: open a room and hand out the three URLs that a run needs — the
 * projector, the handset, and the host's panel. Everything diagnostic lives at
 * `/api/health`, which is where the pre-flight check belongs; this screen is
 * seen by people who are about to play, so it says nothing about the build.
 */

const ENTRIES = [
  {
    href: (code: string) => `/stage/${code}`,
    label: "Projector",
    note: "Bada screen · audio yahin bajta hai",
  },
  {
    href: (code: string) => `/join/${code}`,
    label: "Handset",
    note: "Contestant ka phone · QR isi par jaata hai",
  },
  {
    href: (code: string) => `/host/${code}`,
    label: "Host panel",
    note: "Operator ke liye",
  },
];

export default function HomePage() {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openRoom() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/room", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.code) throw new Error(data.error ?? "Room nahi khula");
      setCode(data.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Room nahi khula");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-dvh scanlines">
      <div className="vignette pointer-events-none absolute inset-0" />

      <div className="relative mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
        <header>
          <p className="label">Kaun Katega</p>
          <h1 className="display mt-1 text-6xl uppercase leading-none">
            Taar<span style={{ color: "var(--brass)" }}>pati</span>
          </h1>
          <p className="mt-4 text-lg" style={{ color: "var(--cream-dim)" }}>
            Paanch taar. Chhe minute. Lock kiya jaye?
          </p>
        </header>

        {!code ? (
          <section className="mt-10">
            <button
              onClick={openRoom}
              disabled={busy}
              className="btn btn-brass w-full py-5 text-base"
            >
              {busy ? "Room khol rahe hain…" : "Naya room kholo"}
            </button>

            {error && (
              <p className="mt-3 text-sm" style={{ color: "var(--signal-red)" }}>
                {error}
              </p>
            )}

            <p
              className="mt-4 text-sm leading-relaxed"
              style={{ color: "var(--cream-faint)" }}
            >
              Room khulne par teen link milenge — ek bade screen ke liye, ek
              contestants ke phone ke liye, aur ek host ke panel ka.
            </p>
          </section>
        ) : (
          <section className="mt-10">
            <div className="panel p-6 text-center">
              <p className="label-dim">Room code</p>
              <p
                className="numerals mt-1 text-7xl leading-none"
                style={{ color: "var(--brass)" }}
              >
                {code}
              </p>
            </div>

            <div className="mt-4 space-y-2">
              {ENTRIES.map((entry) => (
                <a
                  key={entry.label}
                  href={entry.href(code)}
                  className="panel flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:border-[var(--brass)]"
                >
                  <span>
                    <span className="display block text-2xl uppercase leading-none">
                      {entry.label}
                    </span>
                    <span
                      className="mt-1.5 block text-xs"
                      style={{ color: "var(--cream-faint)" }}
                    >
                      {entry.note}
                    </span>
                  </span>
                  <span
                    className="display text-2xl leading-none"
                    style={{ color: "var(--brass)" }}
                    aria-hidden
                  >
                    →
                  </span>
                </a>
              ))}
            </div>

            <button
              onClick={() => setCode(null)}
              className="btn mt-4 w-full"
            >
              Doosra room kholo
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

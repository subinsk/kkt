"use client";

/**
 * The room this screen is showing no longer exists on the server.
 *
 * Rooms live in memory, so they vanish whenever the process restarts — a
 * redeploy, a crash, or a free-tier host waking from sleep. The screens keep
 * rendering the last state they were handed, which means everything looks
 * healthy right up until the next action hits the server and is refused. That is
 * the worst possible shape for a failure: a UI that lies until you touch it.
 *
 * So it says so, unmissably, and offers the only thing that helps.
 */
export function RoomGone({ code }: { code: string }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgb(6_5_4/0.94)] px-6 text-center">
      <div className="max-w-sm">
        <p className="label" style={{ color: "var(--signal-red)" }}>
          Room {code} khatam
        </p>
        <p className="display mt-2 text-4xl uppercase leading-none">
          Server restart
          <br />
          ho gaya
        </p>
        <p className="mt-4 text-sm leading-relaxed" style={{ color: "var(--cream-dim)" }}>
          Is room ka data chala gaya. Screen par jo dikh raha hai wo purana hai —
          server ke paas ye room nahi hai.
        </p>
        <a href="/" className="btn btn-brass mt-6 inline-block px-6 py-3">
          Naya room kholo
        </a>
      </div>
    </div>
  );
}

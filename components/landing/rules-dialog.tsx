"use client";

import { useEffect, useRef } from "react";
import {
  DEFAULT_DURATION_SECONDS,
  PENALTY_HINT,
  PENALTY_LIFELINE,
  PENALTY_WRONG,
  WIRE_COLORS,
} from "@/lib/game/state";

/**
 * The rules, in plain English, for someone who has never seen the show.
 *
 * Every number here is imported from `lib/game/state.ts` rather than typed in.
 * A rules card that disagrees with the server is worse than no card at all —
 * a contestant reads "−20s", loses thirty, and stops trusting the clock at the
 * exact moment the clock is the whole game.
 *
 * Built on a native `<dialog>` and `showModal()`. Escape to close, focus kept
 * inside, and top-layer stacking above the WebGL canvas all come free, and none
 * of the three are worth hand-rolling on the front door.
 */

/** 360 → "6:00". The rules say the clock's length, so it reads like a clock. */
const CLOCK = `${Math.floor(DEFAULT_DURATION_SECONDS / 60)}:${String(
  DEFAULT_DURATION_SECONDS % 60,
).padStart(2, "0")}`;

/** "red, blue, yellow, green and white" — from the real wire list. */
const WIRE_LIST = WIRE_COLORS.slice(0, -1).join(", ")
  .concat(" and ", WIRE_COLORS[WIRE_COLORS.length - 1]);

const COSTS = [
  {
    what: "Wrong answer",
    cost: `−${PENALTY_WRONG}s`,
    note: "The wire stays where it is. Try again, or move on.",
  },
  {
    what: "Hint",
    cost: `−${PENALTY_HINT}s`,
    note: "The host offers one and waits for a yes before charging you.",
  },
  {
    what: "Phone a Friend",
    cost: `−${PENALTY_LIFELINE}s`,
    note: "Once per game, and only if the host agrees.",
  },
  {
    what: "Parking a wire",
    cost: "Free",
    note: "Say you would rather come back to it. The host remembers.",
  },
];

export function RulesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  /**
   * Drive the element from the `open` prop rather than the `open` attribute —
   * the attribute renders a non-modal dialog, which gets no backdrop, no focus
   * containment and no top layer, so it would appear *underneath* the hero
   * canvas.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // `close` fires for the button, for Escape and for a form dismissal, so
      // it is the only place the parent's state needs syncing back.
      onClose={onClose}
      // Clicking the backdrop targets the dialog itself; anything inside the
      // panel targets the panel.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // `m-auto` is load-bearing: a modal <dialog> is centred by the UA's own
      // `margin: auto`, and Tailwind's preflight resets margin to 0 on every
      // element, which pins it to the top-left of the top layer instead.
      className="m-auto max-h-[86dvh] w-[min(38rem,92vw)] border-0 bg-transparent p-0 backdrop:bg-[rgba(4,3,2,0.82)]"
      aria-labelledby="rules-title"
    >
      <div className="panel scanlines relative max-h-[86dvh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-[var(--ink-raised)] px-6 py-5">
          <div>
            <p className="label">How to play</p>
            <h2
              id="rules-title"
              className="display mt-1 text-3xl uppercase leading-none"
            >
              Game Rules
            </h2>
          </div>
          <button
            onClick={onClose}
            className="btn shrink-0 px-3 py-1.5"
            aria-label="Close the rules"
          >
            Close
          </button>
        </div>

        <div className="space-y-7 px-6 py-6">
          <Section title="The setup">
            <p>
              A device with five wires — {WIRE_LIST} — sits between the host and
              the contestants, and a clock starts at {CLOCK}. Cut all five wires
              before it reaches zero and the device is defused. Let it reach zero
              and a confetti charge goes off.
            </p>
            <p>
              Two to four people play, three is the intended number. Everyone
              joins by scanning the QR code on the big screen; the game itself
              happens out loud, so the phone stays mostly out of the way.
            </p>
          </Section>

          <Section title="Cutting a wire">
            <p>
              The host asks a riddle attached to one specific wire. Get it right
              and that wire is cut. You choose the order — ask for the blue one
              and the blue one is what you get.
            </p>
            <p>
              Answer in English, in Hindi, or in whatever mix comes out. Answers
              are judged on meaning, not spelling, so “coconut”, “nariyal” and
              “that brown thing with water in it” all count the same.
            </p>
          </Section>

          <Section title="What costs you time">
            <dl className="divide-y">
              {COSTS.map((row) => (
                <div
                  key={row.what}
                  className="flex items-baseline gap-4 py-2.5 first:pt-0 last:pb-0"
                >
                  <dt className="min-w-0 flex-1">
                    <span className="block" style={{ color: "var(--cream)" }}>
                      {row.what}
                    </span>
                    <span
                      className="block text-sm leading-snug"
                      style={{ color: "var(--cream-faint)" }}
                    >
                      {row.note}
                    </span>
                  </dt>
                  <dd
                    className="numerals shrink-0 text-xl"
                    style={{
                      color:
                        row.cost === "Free"
                          ? "var(--signal-green)"
                          : "var(--signal-red)",
                    }}
                  >
                    {row.cost}
                  </dd>
                </div>
              ))}
            </dl>
            <p>
              Nothing is ever deducted without warning. The host names the price
              and waits for you to agree to it.
            </p>
          </Section>

          <Section title="Talking to each other">
            <p>
              Every phone starts in <strong>Peer Talk</strong>. While it is on,
              the host cannot hear you — you argue with the other contestants
              across the table, for free, for as long as you like.
            </p>
            <p>
              Switch Peer Talk off and you are live. That is when the host hears
              you, and that is the voice that gets an answer locked in.
            </p>
          </Section>

          <Section title="Phone a Friend">
            <p>
              Once a game, the show dials a real phone number. Whoever picks up
              hears the hint read to them on a loop, and they relay it to the
              room.
            </p>
            <p>
              The {PENALTY_LIFELINE}-second charge starts when the call is
              answered, not when it is dialled — ringing is free. If nobody picks
              up, you are refunded in full and the lifeline stays available.
            </p>
          </Section>

          <Section title="Winning and losing">
            <p>
              Five wires cut before {CLOCK} runs out: defused, and the scoreboard
              is a happy one. The clock reaching zero: confetti, and the
              scoreboard is the other kind.
            </p>
          </Section>
        </div>
      </div>
    </dialog>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="label mb-2">{title}</h3>
      <div
        className="space-y-2.5 text-[0.9375rem] leading-relaxed"
        style={{ color: "var(--cream-dim)" }}
      >
        {children}
      </div>
    </section>
  );
}

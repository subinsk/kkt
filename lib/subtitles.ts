/**
 * Cutting a spoken line into subtitle cards.
 *
 * Its own module, away from the 3D component that renders it, for one reason:
 * this is the part that has to survive input nobody designed for, and here it
 * can be asserted by `scripts/engine-check.ts` without a browser or a WebGL
 * context. The failure it guards against is not subtle — a line long enough to
 * overflow its bubble covers the wire panel behind the host, which is the one
 * thing on screen the audience actually needs.
 */

/**
 * The most characters shown on one card.
 *
 * A bubble is not a transcript. The host is held to a sentence or two by his
 * prompt, but the opening line is a paragraph of rules, a lifeline recap runs
 * long, and a model that ignores its instructions can emit anything at all — so
 * length is treated as a certainty rather than an edge case.
 */
export const MAX_CUE_CHARS = 84;

/**
 * How fast the host speaks, in words per second.
 *
 * The single figure for "how long will this line take to say", shared by the
 * subtitle pacing and by the opening-line clock budget in
 * `scripts/engine-check.ts` — two places that were each carrying their own
 * number and disagreeing by a factor of two.
 *
 * Words rather than characters, which is the whole point. A per-character rate
 * is a rate for one script: at the 42ms/char this used to use, the Devanagari
 * opening finished in fourteen seconds against thirty-two seconds of audio, so
 * the subtitle gave away the riddle less than halfway through the sentence
 * asking it. Devanagari spends two or three code points on a syllable that Latin
 * spends one on; words per second barely moves between the two.
 */
export const SPOKEN_WORDS_PER_SECOND = 2.3;

/** Estimated time to say a line, in milliseconds. */
export function spokenDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (Math.max(1, words) / SPOKEN_WORDS_PER_SECOND) * 1000;
}

/** Break here first — a full stop is a real pause in the audio too. */
const SENTENCE_BREAK = /[।?!.]/;
/** Then here. Danda aside, these are the clause joints in Hindi and English. */
const CLAUSE_BREAK = /[—,;:]/;

/**
 * Never break in the first 40% of a card. Without a floor, a line that opens
 * "हाँ, ..." breaks after two characters and the audience gets a card carrying
 * one word.
 */
const MIN_BREAK_FRACTION = 0.4;

export type Cue = {
  /**
   * Offset of this card's first character in the original line.
   *
   * The reveal is paced by a single cursor running over the whole line, so each
   * card has to know where it starts in that line — otherwise the pacing resets
   * at every card boundary and the subtitle drifts out of step with the voice.
   */
  start: number;
  text: string;
};

/**
 * Cut a line into subtitle cards.
 *
 * Boundaries are chosen by preference — sentence, then clause, then the last
 * space — and only then by brute force mid-word. That last case is reserved for
 * input with no break of any kind in it: a URL, a mangled transcript, a model
 * emitting a wall of tokens. It has to be handled rather than assumed away,
 * because without it the loop cannot advance and the caller hangs.
 */
export function toCues(text: string): Cue[] {
  const cues: Cue[] = [];
  let i = 0;

  while (i < text.length) {
    // Whitespace between cards belongs to neither card.
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    if (text.length - i <= MAX_CUE_CHARS) {
      cues.push({ start: i, text: text.slice(i) });
      break;
    }

    const window = text.slice(i, i + MAX_CUE_CHARS);
    const floor = MAX_CUE_CHARS * MIN_BREAK_FRACTION;
    let cut = -1;

    for (const pattern of [SENTENCE_BREAK, CLAUSE_BREAK]) {
      for (let j = window.length - 1; j > floor; j--) {
        if (pattern.test(window[j])) {
          cut = j + 1;
          break;
        }
      }
      if (cut > 0) break;
    }

    if (cut < 0) {
      const space = window.lastIndexOf(" ");
      if (space > floor) cut = space;
    }
    // No break of any kind in a full card's worth of text. Split mid-word
    // rather than loop forever.
    if (cut <= 0) cut = MAX_CUE_CHARS;

    cues.push({ start: i, text: text.slice(i, i + cut).trimEnd() });
    i += cut;
  }

  // An empty or all-whitespace line still has to produce something to render.
  return cues.length ? cues : [{ start: 0, text }];
}

/**
 * The card in play at a given cursor position, and how much of it to show.
 *
 * Shared with the assertions so the renderer and the test agree on what "the
 * cursor is here" means, rather than each having its own idea.
 */
export function cueAt(
  cues: Cue[],
  cursor: number,
): { text: string; shown: string; start: number; end: number } {
  let cue = cues[0];
  for (const candidate of cues) {
    if (cursor >= candidate.start) cue = candidate;
    else break;
  }
  return {
    text: cue.text,
    shown: cue.text.slice(0, Math.max(0, cursor - cue.start)),
    start: cue.start,
    /**
     * One past this card's last character.
     *
     * The renderer needs it for the barge-in case: when the host is cut off
     * mid-line, the card he was on is finished and the rest — which is never
     * going to be spoken — is dropped rather than flickered through.
     */
    end: cue.start + cue.text.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Revealing a line in step with the audio                                    */
/* -------------------------------------------------------------------------- */

/**
 * The pacing machine, as a pure function.
 *
 * It lives here rather than inside the component for the same reason the cue
 * splitter does: this is the part where "the subtitle is in sync" is either true
 * or false, and in a `useFrame` closure that can only be judged by watching it.
 * Out here, `scripts/engine-check.ts` can drive it with a synthetic audio track
 * and assert the two things that actually matter — it never starts before the
 * voice, and it never finishes before the voice.
 *
 * The component keeps the DOM. This keeps the clock.
 */

/**
 * How long a line waits for audio that never comes, before revealing anyway.
 *
 * The host console plays nothing, and a projector can have autoplay blocked; on
 * either of those the level sits at zero forever. Losing the subtitles entirely
 * is a worse failure than losing the sync, so past this the line is revealed on
 * the estimate alone.
 *
 * Generous, because the opening line is published the instant Agora accepts the
 * join and the host cannot speak until the agent has connected to the channel
 * and Sarvam has returned its first audio — seconds, on a cold start.
 */
export const ONSET_TIMEOUT_MS = 6000;

/**
 * Speech has natural gaps — between words, and the beat before a punchline. The
 * level dips through the threshold in all of them, so the reveal keeps running
 * for this long after the last voiced frame rather than stuttering to a halt on
 * every comma.
 */
export const VOICE_GRACE_MS = 420;

/** Silence longer than this means he has finished, not paused. */
export const END_SILENCE_MS = 900;

/**
 * The reveal crawls once it passes this much of the line.
 *
 * Insurance against the estimate being too fast. Running out of text while he is
 * still talking is the failure that is actually confusing to watch — and on a
 * riddle it gives away the answer — so the last few characters are held until
 * the audio confirms he is done. A subtitle that finishes a beat late is
 * invisible; one that finishes early is a bug you can see.
 */
export const HOLD_FRACTION = 0.94;

/** The rate the reveal drops to once past `HOLD_FRACTION`. */
export const CRAWL_RATE = 0.12;

/** Once the audio has stopped, the rest of the line lands this fast. */
export const CATCHUP_RATE = 7;

/**
 * How far through a line the reveal must be, when the audio stops, for that stop
 * to count as him FINISHING rather than being cut off.
 *
 * Nothing in the audio distinguishes the two — a barge-in and a full stop are
 * both just the level going quiet — so this is the only signal available, and it
 * is a judgement about which mistake to make.
 *
 * Below the line, the rest is dropped: a contestant who interrupts does so
 * early, and printing the remaining four cards of a riddle nobody heard hands
 * them the answer. Above it, the rest is revealed: Sarvam simply delivered
 * faster than the estimate, and dropping the last card would lose words he
 * actually said. Half is a long way from either failure — an interruption lands
 * far below it, and the estimate would have to be wrong by more than a factor of
 * two to land above it.
 */
export const FINISHED_FRACTION = 0.5;

/** How long a finished card sits there before the bubble goes. */
export const LINGER_MS = 2200;

export type Reveal = {
  /** Characters revealed so far, fractional between frames. */
  cursor: number;
  /** Seconds since the line arrived, waiting for him to start. */
  waiting: number;
  /**
   * Whether the level has been seen BELOW the threshold since this line
   * arrived. Without it the tail of the PREVIOUS line is mistaken for the start
   * of this one, and the new card opens mid-sentence.
   */
  armed: boolean;
  /** He has been heard. Nothing is drawn before this. */
  started: boolean;
  /** Seconds since the last voiced frame. */
  quiet: number;
  /** The audio is over. */
  ended: boolean;
  /**
   * The furthest the cursor may go, fixed at the moment the audio stops.
   *
   * `Infinity` while he is still talking. When he stops it becomes the end of
   * the card he was on — the whole line if he finished normally, only the
   * current card if he was cut off. Barge-in triggers on 160ms of speech, so
   * being interrupted mid-line is routine, and flickering through four more
   * cards of a sentence the room never heard is worse than showing nothing.
   */
  limit: number;
  /** Seconds the finished card has been sitting there. */
  lingering: number;
};

export function newReveal(): Reveal {
  return {
    cursor: 0,
    waiting: 0,
    armed: false,
    started: false,
    quiet: 0,
    ended: false,
    limit: Infinity,
    lingering: 0,
  };
}

/**
 * Advance one frame. Mutates `r` — it is called sixty times a second and
 * allocating a new object each time is the one thing here worth avoiding.
 */
export function advanceReveal(
  r: Reveal,
  opts: {
    /** Seconds since the last frame. */
    dt: number;
    /** True when the host's measured output level says he is speaking. */
    voiced: boolean;
    cues: Cue[];
    total: number;
    charsPerSecond: number;
  },
): { visible: boolean; done: boolean } {
  const { dt, voiced, cues, total, charsPerSecond } = opts;

  /* -- wait for him to actually open his mouth ---------------------------- */
  if (!r.started) {
    r.waiting += dt;
    // Silence first, then sound. See `armed`.
    if (!voiced) r.armed = true;
    if (!((r.armed && voiced) || r.waiting * 1000 > ONSET_TIMEOUT_MS)) {
      return { visible: false, done: false };
    }
    r.started = true;
  }

  /* -- has he stopped? ---------------------------------------------------- */
  if (voiced) {
    r.quiet = 0;
    r.ended = false;
    r.limit = Infinity;
  } else {
    r.quiet += dt;
    if (r.quiet * 1000 > END_SILENCE_MS && !r.ended) {
      r.ended = true;
      // Far enough in that he must have finished: release the whole line, and
      // let the catch-up close whatever the estimate left behind. Short of that,
      // he was cut off — finish the card he was on and drop the rest.
      r.limit =
        r.cursor >= total * FINISHED_FRACTION
          ? total
          : cueAt(cues, Math.floor(r.cursor)).end;
    }
  }

  /* -- advance the cursor ------------------------------------------------- */
  const target = Math.min(total, r.limit);

  if (r.ended) {
    // Audio is over. Finish the card he was on and stop there.
    r.cursor = Math.min(target, r.cursor + dt * charsPerSecond * CATCHUP_RATE);
  } else if (voiced || r.quiet * 1000 < VOICE_GRACE_MS) {
    // Past the hold point the reveal crawls rather than stopping dead, so the
    // hold reads as him slowing down rather than as the bubble freezing.
    const crawling = r.cursor > total * HOLD_FRACTION;
    r.cursor = Math.min(
      target,
      r.cursor + dt * charsPerSecond * (crawling ? CRAWL_RATE : 1),
    );
  }

  /* -- linger, then go ---------------------------------------------------- */
  const revealing = r.cursor < target;
  if (!revealing && r.ended) r.lingering += dt;
  else r.lingering = 0;

  return {
    visible: r.lingering * 1000 <= LINGER_MS,
    done: !revealing,
  };
}

/**
 * Characters per second for one line.
 *
 * `wordsPerSecond` is the *measured* rate when the ledger has one, and this is
 * the single most effective thing available for closing the gap between the
 * subtitle and the voice. `SPOKEN_WORDS_PER_SECOND` is a guess that applies for
 * the whole length of a line, so on a forty-second greeting a rate 30% out puts
 * the text twelve seconds away from the audio — which reads as the subtitle
 * showing something else entirely rather than as a slight lag.
 *
 * Sarvam sends no word timings, so the interior of a line cannot be made exact
 * (see docs/AGORA-NOTES.md). Measuring the rate removes the systematic error and
 * leaves only the variation within a sentence.
 */
export function charsPerSecondFor(text: string, wordsPerSecond?: number | null): number {
  const rate =
    wordsPerSecond && wordsPerSecond > 0 ? wordsPerSecond : SPOKEN_WORDS_PER_SECOND;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const ms = (Math.max(1, words) / rate) * 1000;
  return (text.length / ms) * 1000;
}

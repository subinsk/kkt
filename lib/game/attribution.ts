/**
 * Who said that? — spec §2.5.
 *
 * Agora mixes the channel, so a transcript on its own does not say which of
 * three contestants spoke. Two signals, in priority order:
 *
 *   1. The transcript's own `uid`. Transcript items are documented as
 *      `{ uid, turn_id, text, status, metadata }`, so the field exists.
 *      **UNVERIFIED at runtime:** whether that uid resolves to the individual
 *      publisher in a three-publisher channel, or only separates agent from
 *      "the humans". Resolve by experiment: three phones, three distinct
 *      sentences, read the uids. If it resolves per-player, this file becomes
 *      decoration.
 *
 *   2. Mic-level telemetry. Each phone reports its own local level; the loudest
 *      integrated level across the utterance window wins. Each person's phone
 *      is closest to their own mouth, so in practice the margin is wide.
 *
 * `contested` is a first-class outcome rather than a failure. Handing it to the
 * host so he serializes the floor by name *is* the multi-party turn-taking
 * capability, and judges will deliberately talk over each other to test it.
 */

export type LevelSample = { t: number; level: number };

/** How much history to keep per player. Utterances are far shorter than this. */
const WINDOW_MS = 5000;

/**
 * Absolute floor. Below this the room is just noise and we would rather say
 * "unclear" than name the wrong contestant in front of an audience.
 */
const MIN_ENERGY = 0.5;

/**
 * How much louder the winner must be than the runner-up. Tuned low-ish because
 * a phone at your mouth beats a phone across a desk by a lot; raise it if the
 * hall is loud and attribution starts flapping.
 */
const CONTESTED_RATIO = 1.4;

/** Hold-to-talk multiplies a player's energy so the override always wins. */
const HOLD_BOOST = 4;

type Timeline = {
  samples: Map<string, LevelSample[]>;
  /** playerId → timestamp until which hold-to-talk is considered active. */
  holding: Map<string, number>;
};

const globalStore = globalThis as unknown as {
  __kktLevels?: Map<string, Timeline>;
};
const timelines: Map<string, Timeline> = (globalStore.__kktLevels ??= new Map());

function timelineFor(code: string): Timeline {
  let t = timelines.get(code);
  if (!t) {
    t = { samples: new Map(), holding: new Map() };
    timelines.set(code, t);
  }
  return t;
}

/**
 * Ingest a batch of level samples from one phone.
 *
 * Batched rather than one-per-sample: the phones measure at ~30Hz as the spec
 * describes, but they POST every 200ms with the six samples collected since the
 * last send. Thirty HTTP requests per second per handset would be absurd, and
 * the attribution maths only cares about the integral, not the arrival rate.
 */
export function recordLevels(
  code: string,
  playerId: string,
  samples: LevelSample[],
) {
  const timeline = timelineFor(code);
  const existing = timeline.samples.get(playerId) ?? [];
  const merged = [...existing, ...samples];

  const cutoff = Date.now() - WINDOW_MS;
  timeline.samples.set(
    playerId,
    merged.filter((s) => s.t >= cutoff),
  );
}

export function setHolding(code: string, playerId: string, holding: boolean) {
  const timeline = timelineFor(code);
  if (holding) {
    // Expires on its own, so a phone that dies mid-hold cannot pin attribution
    // to a contestant who has left the conversation.
    timeline.holding.set(playerId, Date.now() + 8000);
  } else {
    timeline.holding.delete(playerId);
  }
}

export function isHolding(code: string, playerId: string): boolean {
  const until = timelineFor(code).holding.get(playerId);
  return until !== undefined && until > Date.now();
}

export type Attribution = {
  playerId: string | null;
  contested: boolean;
  /** 0..1, for the host console and for debugging on the projector. */
  confidence: number;
  source: "live" | "hold" | "level" | "uid" | "none";
  scores: Record<string, number>;
};

/**
 * Who spoke, cheapest signal first.
 *
 * The transcript cannot tell us — Agora mixes the channel and human items come
 * back as `uid: 0`, verified 24 Aug 2026, see docs/AGORA-NOTES.md. So this is the
 * only answer available, and it is deliberately layered so the guessing is the
 * *last* resort rather than the first:
 *
 *   1. Only one contestant is published → it was them. A fact, not a score.
 *   2. Somebody is holding their talk button → it was them. Also a fact.
 *   3. Otherwise, integrate mic energy over the window and take the argmax.
 *   4. Too close to call → `contested`, and the host arbitrates by name.
 *
 * `candidates` is what makes the first layer possible, and it matters for the
 * third too: a contestant in Peer Talk is not published to the channel at all,
 * so the agent could not have heard them no matter how loudly their own handset
 * measured them. Scoring them would let a lively side-discussion outrank the one
 * person actually on air — and the cost of that is the host saying the wrong
 * name out loud.
 */
export function attribute(
  code: string,
  startMs: number,
  endMs: number,
  candidates?: string[],
): Attribution {
  const timeline = timelineFor(code);
  const scores: Record<string, number> = {};

  /**
   * Exactly one person is audible, so there is nothing to work out.
   *
   * This is the common case by design — Peer Talk keeps handsets muted until a
   * contestant deliberately goes live — and it is the reason the level heuristic
   * is a corner case rather than the mechanism. It also sidesteps a question we
   * have not answered: whether a muted local track still reports a mic level.
   * If it does, scoring it would be actively harmful; not scoring it makes the
   * question moot.
   */
  if (candidates && candidates.length === 1) {
    return {
      playerId: candidates[0],
      contested: false,
      confidence: 1,
      source: "live",
      scores: {},
    };
  }

  for (const [playerId, samples] of timeline.samples) {
    if (candidates && !candidates.includes(playerId)) continue;
    const energy = samples
      .filter((s) => s.t >= startMs && s.t <= endMs)
      .reduce((sum, s) => sum + s.level, 0);
    scores[playerId] = isHolding(code, playerId) ? energy * HOLD_BOOST : energy;
  }

  /**
   * Hold-to-talk is an override, so treat it as one.
   *
   * `HOLD_BOOST` multiplies a holder's energy, and the comment above it claimed
   * that made the override "always win" — it does not. A 4x boost loses to a
   * neighbour who is six times louder, which is an ordinary gap between a phone
   * at someone's mouth and a phone across a desk. So a contestant physically
   * holding the button could still be attributed to somebody else, which is the
   * one thing a push-to-talk button exists to prevent.
   *
   * When anyone is holding, only holders are candidates. The boost still decides
   * between two people holding at once, and `contested` still applies to them.
   */
  const holders = Object.keys(scores).filter((id) => isHolding(code, id));
  const pool = holders.length
    ? Object.fromEntries(holders.map((id) => [id, scores[id]]))
    : scores;

  const ranked = Object.entries(pool).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;

  if (!best || best[1] < MIN_ENERGY) {
    return { playerId: null, contested: false, confidence: 0, source: "none", scores };
  }

  const source = isHolding(code, best[0]) ? "hold" : "level";

  if (second && second[1] > 0 && best[1] < second[1] * CONTESTED_RATIO) {
    // A feature, not a failure — the host arbitrates by name.
    return {
      playerId: best[0],
      contested: true,
      confidence: best[1] / (best[1] + second[1]),
      source,
      scores,
    };
  }

  const total = ranked.reduce((sum, [, v]) => sum + v, 0) || 1;
  return {
    playerId: best[0],
    contested: false,
    confidence: best[1] / total,
    source,
    scores,
  };
}

/** Drop a finished room's telemetry so a long-running dev server does not grow. */
export function clearLevels(code: string) {
  timelines.delete(code);
}

/**
 * The window to attribute a finished utterance over.
 *
 * `attribute` needs a start and an end, and until now nothing in the system knew
 * either — which is the entire reason it was never called and every
 * `setSpeaker()` hardcoded `contested: false`. The 30Hz telemetry from three
 * phones was being collected into a store nothing read.
 *
 * What we actually have, server-side, is the moment the finished transcript
 * arrived. So the window is derived backwards from it: however long those words
 * take to say, plus a margin for the end-of-speech detection that had to elapse
 * before Agora called the turn finished.
 *
 * Clamped to the telemetry window, because there are no samples older than that
 * to integrate and a longer reach would silently include nothing.
 */
export function speechWindow(
  text: string,
  endMs = Date.now(),
): { startMs: number; endMs: number } {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const spoken = (Math.max(1, words) / 2.3) * 1000;
  // Agora's semantic end-of-speech waits ~380ms of silence before finalising, so
  // the words themselves ended a little before the transcript reached us.
  const padding = 700;
  const span = Math.min(spoken + padding, WINDOW_MS);
  return { startMs: endMs - span, endMs };
}

/* -------------------------------------------------------------------------- */
/* Self-echo filter — spec §2.4                                               */
/* -------------------------------------------------------------------------- */

/**
 * In Mode A the room speaker leaks into three open phone mics, and each phone's
 * AEC cannot help because it is not the device making the sound. So: we know
 * exactly what text we sent to TTS, and we drop inbound transcripts that match
 * it before they ever reach the LLM.
 */

const ECHO_WINDOW_MS = 10000;

const echoStore = globalThis as unknown as {
  __kktEcho?: Map<string, { text: string; at: number }[]>;
};
const recentAgentSpeech: Map<string, { text: string; at: number }[]> =
  (echoStore.__kktEcho ??= new Map());

export function rememberAgentUtterance(code: string, text: string) {
  if (!text.trim()) return;
  const list = recentAgentSpeech.get(code) ?? [];
  list.push({ text, at: Date.now() });
  recentAgentSpeech.set(
    code,
    list.filter((u) => u.at > Date.now() - ECHO_WINDOW_MS),
  );
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / Math.min(A.size, B.size);
}

export function isSelfEcho(code: string, transcript: string): boolean {
  const t = norm(transcript);
  // Very short utterances are "haan", "nahi", "arre" — real answers, and too
  // short to match reliably. Never filter them.
  if (t.length < 6) return false;

  const recent = (recentAgentSpeech.get(code) ?? []).filter(
    (u) => u.at > Date.now() - ECHO_WINDOW_MS,
  );

  return recent.some((u) => {
    const a = norm(u.text);
    if (a.length < 6) return false;
    if (a.includes(t) || t.includes(a)) return true;
    return trigramSimilarity(a, t) > 0.6;
  });
}

/**
 * Remove the host's own words from a transcript and keep whatever is left.
 *
 * # The bug this replaces
 *
 * `isSelfEcho` answers a yes/no question, and the caller acted on it by
 * discarding the entire turn. With one person speaking that is correct. With the
 * room speaker leaking into three open mics *while somebody answers over it*,
 * both land in a single ASR turn — and because the match is a containment test,
 * the transcript "…नारियल… <host's whole sentence>" contains the host's line, so
 * the **answer was thrown away with the echo**, silently, before the model ever
 * saw it. A contestant answering during the host's sentence simply went unheard.
 *
 * So the question is not "is this an echo" but "which part of this is an echo".
 * Subtract that part and judge what remains.
 *
 * # Why the leftovers are still worth keeping
 *
 * The remainder is often mangled — a mixed-voice transcript is not clean text.
 * That is fine, because answer checking is semantic and not string matching: the
 * host is perfectly capable of reading "नारियल जैसा कुछ" as a coconut. A garbled
 * real answer reaching him beats a clean silence.
 *
 * Returns the empty string when the whole turn was echo, which the caller treats
 * exactly as the old boolean's `true`.
 */
export function stripEcho(code: string, transcript: string): string {
  const raw = transcript.trim();
  if (!raw) return "";
  const t = norm(raw);
  if (t.length < 6) return raw;

  const recent = (recentAgentSpeech.get(code) ?? []).filter(
    (u) => u.at > Date.now() - ECHO_WINDOW_MS,
  );

  let kept = raw;
  for (const u of recent) {
    const a = norm(u.text);
    if (a.length < 6) continue;

    const normKept = norm(kept);
    /**
     * Whole-turn match: nothing but echo, or an echo that swallowed the turn.
     *
     * `normKept.includes(a)` is the case worth being careful about — it is the
     * mixed transcript. Rather than dropping everything, cut the matched span
     * out of the ORIGINAL string and keep the rest.
     */
    if (a.includes(normKept)) return "";
    if (normKept.includes(a)) {
      kept = cutSpan(kept, a);
      continue;
    }
    // Fuzzy whole-turn match: ASR mangled the echo enough that no exact span
    // exists to cut, so there is nothing to salvage either.
    if (trigramSimilarity(a, normKept) > 0.6) return "";
  }

  // Punctuation and connective debris left where the echo used to be.
  const cleaned = kept.replace(/\s{2,}/g, " ").replace(/^[\s,।.-]+|[\s,]+$/g, "");

  /**
   * Keep anything with a letter in it. Do NOT reuse the six-character floor.
   *
   * That floor is measured on the normalised string, and `norm` strips combining
   * marks — a matra is neither \p{L} nor \p{N} — so a Devanagari word normalises
   * down to its bare consonants. "नारियल" is six characters and normalises to
   * four, which means the floor was throwing away the canonical answer to the
   * red-wire riddle. Anything short enough to trip it is exactly the kind of
   * one-word answer this game is made of.
   *
   * The floor still belongs in `isSelfEcho`, where it guards *matching* — being
   * reluctant to call something an echo is the safe direction. Here it would
   * guard *keeping*, where the same reluctance is inverted into a bug.
   *
   * Same test `sanitizeSpoken` uses in lib/llm.ts for the same reason.
   */
  return /\p{L}/u.test(cleaned) ? cleaned : "";
}

/**
 * Cut the span matching `needle` out of `haystack`, working in normalised space
 * but slicing the original.
 *
 * The two strings do not line up character for character — `norm` drops
 * punctuation and collapses whitespace — so the match is located by walking the
 * original and counting how many normalised characters have been passed. Cruder
 * than a real alignment, and enough for this: the goal is only to stop the echo
 * from eating the sentence next to it.
 */
function cutSpan(haystack: string, needle: string): string {
  /**
   * Cut by whole whitespace tokens rather than by character offsets.
   *
   * Two things bit here, both only visible on real input.
   *
   * The first attempt walked the original string counting normalised characters.
   * That is wrong in a way only Devanagari shows: `norm` strips combining marks,
   * because a matra is neither \p{L} nor \p{N}, so the normalised form of a word
   * is its bare consonants. The index arithmetic ran one consonant long and the
   * cut took the first letter of the *answer* with it — "नारियल" came back as
   * "ारियल", failed the six-character floor, and the turn was thrown away as an
   * echo. Exactly the bug this function exists to prevent, one layer down.
   *
   * Tokens fixed that, and then punctuation broke it: the host's line contains a
   * standalone em dash, `norm("—")` is empty, and a blank in the middle of a
   * joined run means it can never equal the target. Hence matching over the
   * non-empty tokens only, while cutting the original span from first to last —
   * which takes any punctuation sitting inside the match along with it.
   */
  const tokens = haystack.split(/\s+/).filter(Boolean);
  const words = tokens
    .map((t, i) => ({ i, n: norm(t) }))
    .filter((w) => w.n.length > 0);
  const target = norm(needle);
  if (!target) return haystack;

  for (let from = 0; from < words.length; from++) {
    let joined = "";
    for (let to = from; to < words.length; to++) {
      joined = joined ? `${joined} ${words[to].n}` : words[to].n;
      if (joined === target) {
        const cutFrom = words[from].i;
        const cutTo = words[to].i;
        const rest = [
          ...tokens.slice(0, cutFrom),
          ...tokens.slice(cutTo + 1),
        ];
        return rest.join(" ");
      }
      if (joined.length > target.length) break;
    }
  }
  return haystack;
}

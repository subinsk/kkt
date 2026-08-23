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
  source: "hold" | "level" | "uid" | "none";
  scores: Record<string, number>;
};

/**
 * Integrate each player's level across the utterance window and take the argmax.
 */
export function attribute(
  code: string,
  startMs: number,
  endMs: number,
): Attribution {
  const timeline = timelineFor(code);
  const scores: Record<string, number> = {};

  for (const [playerId, samples] of timeline.samples) {
    const energy = samples
      .filter((s) => s.t >= startMs && s.t <= endMs)
      .reduce((sum, s) => sum + s.level, 0);
    scores[playerId] = isHolding(code, playerId) ? energy * HOLD_BOOST : energy;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
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

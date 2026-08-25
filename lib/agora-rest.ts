import { appId as agoraAppId, optional, publicBaseUrl, required } from "./env";
import { AGORA_FAILURE_LINE, FILLER_PHRASES } from "./agent-config";

/**
 * Thin wrapper over the Conversational AI Engine REST API.
 *
 * Every field here was checked against the Agora docs — see AGENTS.md, which
 * forbids writing this file from memory. The reason is that the failures are
 * silent: a missing RTM flag does not error, transcripts simply never arrive.
 */

const BASE = "https://api.agora.io/api/conversational-ai-agent/v2/projects";

function authHeader(): string {
  const id = required("AGORA_CUSTOMER_ID");
  const secret = required("AGORA_CUSTOMER_SECRET");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

/**
 * A failed Agora call, with the status and reason kept as fields.
 *
 * The message alone was not enough: callers need to tell "this agent is gone"
 * (404 / TaskNotFound, which is a normal thing to discover) apart from "Agora
 * is unhappy" (anything else, which must not be treated as gone — assuming a
 * live agent is dead is how you end up with two hosts talking over each other).
 */
export class AgoraError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(path: string, status: number, body: string, reason: string | null) {
    super(`Agora ${path} failed (${status}): ${body}`);
    this.name = "AgoraError";
    this.status = status;
    this.reason = reason;
  }
}

/** True when Agora is telling us this agent no longer exists. */
export function agentIsGone(error: unknown): boolean {
  return (
    error instanceof AgoraError &&
    (error.status === 404 || error.reason === "TaskNotFound")
  );
}

export async function agoraFetch<T>(
  path: string,
  init: { method: "POST" | "GET"; body?: unknown },
): Promise<T> {
  const res = await fetch(`${BASE}/${agoraAppId()}${path}`, {
    method: init.method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    // Non-200 responses are { detail, reason } — surface both, they are useful.
    let reason: string | null = null;
    try {
      reason = (JSON.parse(text) as { reason?: string }).reason ?? null;
    } catch {
      // Not JSON. The status still tells us what we need.
    }
    throw new AgoraError(path, res.status, text, reason);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Make the host say an exact line, without a round trip through the LLM.
 *
 * Used for the moments that must not be improvised: the lifeline announcement,
 * and the closing line after the outcome stinger has finished playing.
 *
 * The two options do opposite jobs and it is easy to reach for the wrong one:
 *
 *   - `interruptable: false` protects the line we are ABOUT to say from the room
 *     — a cheering hall cannot cut the host off during the payoff beat.
 *   - `priority` decides what happens to the line already in progress.
 *
 * Agora's own default for `priority` is `INTERRUPT`, documented as "immediately
 * interrupts the current interaction". **We default to `APPEND` instead**, and
 * the reason is a bug this caused: every lifeline announcement guillotined
 * whatever sentence the host was in the middle of, so the room heard half a
 * riddle and the screen showed the announcement. `interruptable: false` did not
 * help, because it protects the incoming line and says nothing about the one
 * being destroyed.
 *
 * A caller that genuinely wants to cut in must now say so. Nothing currently
 * does — the pre-stinger cut goes through `interruptAgent` instead, which is
 * clearer about what it is doing.
 */
export async function speak(
  agentId: string,
  text: string,
  opts?: { interruptable?: boolean; priority?: SpeakPriority },
) {
  return agoraFetch(`/agents/${agentId}/speak`, {
    method: "POST",
    body: {
      text,
      priority: opts?.priority ?? "APPEND",
      interruptable: opts?.interruptable ?? true,
    },
  });
}

/**
 * Agora's three broadcast priorities, with the documented meaning of each:
 *
 *   INTERRUPT — "immediately interrupts the current interaction"
 *   APPEND    — "announces the message after the current interaction ends"
 *   IGNORE    — discarded entirely if the agent is busy
 */
export type SpeakPriority = "INTERRUPT" | "APPEND" | "IGNORE";

/**
 * `/speak` caps `text` at 512 **bytes**, not characters.
 *
 * Worth stating as a constant because the unit is the trap: Devanagari spends
 * three bytes per code point, so the real ceiling is roughly 170 characters and
 * a line that reads short on screen can be well over it. `npm run check`
 * measures every verbatim line against this.
 */
export const SPEAK_TEXT_MAX_BYTES = 512;

/**
 * Covers the dead air while a tool resolves (spec §8). In this game the latency
 * reads as suspense rather than lag, which is a free pass on the thing that
 * usually damages voice demos — so lean into it.
 *
 * Its own function, and exported, purely so `npm run check` can read the key
 * names back. The nesting is asymmetric in a way that has already bitten once:
 *
 *   trigger  → `fixed_time_config`
 *   content  → `static_config`
 *
 * Neither is plain `config`. `content` was correct because Agora rejects the
 * wrong key there with a 400 naming the exact path — so the mistake announced
 * itself. `trigger` does not: the request is accepted, the threshold is
 * discarded, and fillers fire on whatever the server default is. Nothing errors
 * and nothing logs, which is why the assertion exists rather than a comment.
 *
 * Verified against all four samples on the filler-words page, 24 Aug 2026. See
 * docs/AGORA-NOTES.md.
 */
export function fillerWordsConfig() {
  return {
    enable: true,
    trigger: {
      mode: "fixed_time",
      fixed_time_config: { response_wait_ms: 1200 },
    },
    content: {
      mode: "static",
      static_config: {
        // Devanagari, for the same reason as everything else spoken: Bulbul
        // reads Roman script as English. Length-capped — see FILLER_PHRASES.
        phrases: FILLER_PHRASES,
        selection_rule: "shuffle",
      },
    },
  };
}

/**
 * Cut the host off mid-utterance.
 *
 * Needed before the endgame stinger (spec §10.2) — otherwise the host either
 * talks across the MP3 or hears "aag aag" through the open phone mics and
 * starts reacting to it.
 */
export async function interruptAgent(agentId: string) {
  return agoraFetch(`/agents/${agentId}/interrupt`, { method: "POST" });
}

export async function agentStatus(agentId: string) {
  return agoraFetch<{ status: string; start_ts?: number }>(`/agents/${agentId}`, {
    method: "GET",
  });
}

/**
 * The agent's ASR → LLM → TTS pipeline.
 *
 * `llm.url` points at our own proxy rather than at a model provider. That is
 * the spine of the build: the proxy is where authoritative game state gets
 * injected into every turn and where tool calls actually execute. Agora streams
 * model output straight to TTS, so a tool call reaching Agora would just be
 * read aloud as gibberish.
 */
export function buildAgentProperties(opts: {
  channel: string;
  token: string;
  agentUid: string;
  systemPrompt: string;
  greeting: string;
}) {
  const baseUrl = publicBaseUrl();

  return {
    channel: opts.channel,
    token: opts.token,
    // A string, not an int — an int is rejected at the API boundary.
    agent_rtc_uid: opts.agentUid,
    /**
     * The identity the agent uses on the RTM channel.
     *
     * Transcripts are published *by the agent* over RTM, so it needs an RTM
     * identity, and that identity has to be the one its token authorises. The
     * token is minted by `buildTokenWithRtm` with the agent's uid as the
     * account, so this is the same string — matching `agent_rtc_uid` above.
     *
     * **Documented only by example.** This field appears in the request samples
     * on the `/join` reference page but has no entry in the parameter list, so
     * there is no stated default and no stated behaviour when it is omitted.
     * Setting it explicitly removes the guess.
     */
    agent_rtm_uid: opts.agentUid,
    /**
     * The wildcard, in array form. Three phones publish, and the agent must
     * hear all of them for this to be a group conversation rather than three
     * separate dialogues (spec §2.2). The wildcard also covers a contestant who
     * joins late or reconnects with the same uid, which enumerating would not.
     */
    remote_rtc_uids: ["*"],
    // Longer than the six-minute round, so a quiet stretch mid-game can never
    // evict the host.
    idle_timeout: 600,

    llm: {
      url: `${baseUrl}/api/llm?room=${encodeURIComponent(opts.channel)}`,
      // The proxy authenticates upstream itself; Agora just needs non-empty.
      api_key: optional("PROXY_SHARED_SECRET", "unused"),
      system_messages: [{ role: "system", content: opts.systemPrompt }],
      max_history: 40,
      greeting_message: opts.greeting,
      failure_message: AGORA_FAILURE_LINE,
      params: { model: optional("LLM_MODEL", "gpt-4o-mini"), stream: true },
    },

    /**
     * Sarvam Bulbul. `abhilash` is the deep male voice — the closest thing to a
     * game-show host in the roster. Pace is slightly under 1 because gravitas
     * is mostly a function of speaking slowly.
     */
    tts: {
      vendor: "sarvam",
      params: {
        api_subscription_key: required("SARVAM_API_KEY"),
        speaker: optional("SARVAM_TTS_SPEAKER", "abhilash"),
        target_language_code: optional("SARVAM_TTS_LANGUAGE", "hi-IN"),
        pitch: Number(optional("SARVAM_TTS_PITCH", "-0.1")),
        pace: Number(optional("SARVAM_TTS_PACE", "0.95")),
        loudness: 1.2,
        sample_rate: 24000,
      },
    },

    /**
     * Sarvam Saaras. `language: "unknown"` turns on auto-detection, which is
     * the whole code-switching capability (spec §6): a contestant can answer
     * "nariyal" or "coconut" or half of each and it transcribes either way.
     */
    asr: {
      vendor: "sarvam",
      language: optional("ASR_LANGUAGE", "hi-IN"),
      params: {
        api_key: required("SARVAM_API_KEY"),
        language: optional("SARVAM_ASR_LANGUAGE", "unknown"),
      },
    },

    /**
     * Barge-in. Requirement #4, and scripted into the demo at 0:50 — a judge
     * cuts the host off mid-sentence and he adapts.
     *
     * These numbers are the starting point from spec §13, not the final ones.
     * Retune them in the actual room at actual noise levels: too low and a
     * cough stops the host, too high and interruption feels broken.
     */
    turn_detection: {
      mode: "default",
      config: {
        speech_threshold: 0.5,
        start_of_speech: {
          mode: "vad",
          vad_config: {
            interrupt_duration_ms: Number(optional("INTERRUPT_DURATION_MS", "160")),
            speaking_interrupt_duration_ms: Number(
              optional("SPEAKING_INTERRUPT_DURATION_MS", "320"),
            ),
            prefix_padding_ms: 600,
          },
        },
        end_of_speech: {
          mode: "semantic",
          semantic_config: {
            silence_duration_ms: Number(optional("SILENCE_DURATION_MS", "380")),
            max_wait_ms: 3000,
          },
        },
      },
    },

    /**
     * Covers the dead air while a tool resolves (spec §8). In this game the
     * latency reads as suspense rather than lag, which is a free pass on the
     * thing that usually damages voice demos — so lean into it.
     */
    filler_words: fillerWordsConfig(),

    /**
     * Transcripts and agent-state events arrive over RTM, and they need BOTH
     * of the flags below. One without the other fails silently — the events
     * simply never fire and there is nothing in any log to say why.
     *
     * The RTM channel name is the same as the RTC channel name.
     */
    advanced_features: {
      enable_rtm: true,
    },

    parameters: {
      data_channel: "rtm",
      enable_metrics: true,
      enable_error_message: true,
      silence_config: {
        /**
         * Three and a half seconds.
         *
         * Broadcast pacing, not chat pacing: three seconds of dead air on a game
         * show is an eternity, and a host who lets it sit reads as broken rather
         * than patient. The extra half-second absorbs end-of-speech detection so
         * a contestant drawing breath mid-answer is not treated as silence.
         *
         * The risk this creates is a host who natters over people thinking, so
         * two things hold it back: the escalation ladder means each prod is a new
         * step rather than a repeat, and the prompt requires an EMPTY response
         * when everyone is in Peer Talk — where he cannot be heard anyway, and
         * where filling the gap would just talk over their discussion.
         */
        timeout_ms: 3500,
        action: "think",
        content:
          "A few seconds have passed with no answer. If LIVE STATE says every contestant is in Peer Talk, reply with an EMPTY response and say nothing at all — they cannot hear you and they are mid-discussion. Otherwise take the NEXT step on your escalation ladder that you have not already used on this wire: nudge by name, then rephrase the riddle in different words, then offer the hint with its cost, then offer to park the wire. Exactly one step, one short sentence, Devanagari. Never greet, never re-introduce the show, never start a new riddle, never repeat a sentence you have already said.",
      },
    },
  };
}

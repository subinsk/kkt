import { appId as agoraAppId, optional, publicBaseUrl, required } from "./env";
import { FILLER_PHRASES } from "./agent-config";

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
 * and the closing line after the outcome stinger has finished playing. Setting
 * `interruptable: false` stops a cheering room from cutting the host off
 * mid-sentence during the payoff beat.
 */
export async function speak(
  agentId: string,
  text: string,
  opts?: { interruptable?: boolean; priority?: "INTERRUPT" | "APPEND" | "IGNORE" },
) {
  return agoraFetch(`/agents/${agentId}/speak`, {
    method: "POST",
    body: {
      text,
      priority: opts?.priority ?? "INTERRUPT",
      interruptable: opts?.interruptable ?? true,
    },
  });
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
      failure_message: "एक मिनट... लाइन में कुछ गड़बड़ है।",
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
    filler_words: {
      enable: true,
      trigger: { mode: "fixed_time", config: { response_wait_ms: 1200 } },
      content: {
        mode: "static",
        // `static_config`, not `config`. Agora rejects the latter with a 400
        // naming this exact path — the nested key differs from the one used by
        // `trigger`, which really does take `config`.
        static_config: {
          // Devanagari, for the same reason as everything else spoken: Bulbul
          // reads Roman script as English. Length-capped — see FILLER_PHRASES.
          phrases: FILLER_PHRASES,
          selection_rule: "shuffle",
        },
      },
    },

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
        // Long enough that thinking is not treated as a problem — a riddle takes
        // a while, and interrupting that is worse than a pause.
        timeout_ms: 25000,
        action: "think",
        content:
          "Nobody has answered for a while. Follow your escalation ladder: nudge by name, then rephrase the riddle, then offer the hint with its cost, then offer to park the wire. Pick the NEXT step you have not used yet on this wire, do exactly that one thing in Devanagari, in one short sentence, and stop. Do not greet, do not re-introduce the show, do not start a new riddle.",
      },
    },
  };
}

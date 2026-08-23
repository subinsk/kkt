/**
 * Upstream model adapters.
 *
 * Agora's Conversational AI Engine only speaks one dialect on the way *in*: an
 * OpenAI-compatible `/chat/completions` endpoint. That is fixed, and it is what
 * `app/api/llm/route.ts` exposes. What sits *behind* our proxy is our choice,
 * so this file translates in both directions and lets `LLM_PROVIDER` pick.
 *
 * Why bother supporting two shapes: on event day a rate limit or a provider blip
 * is a dead demo, and flipping one environment variable is a far better recovery
 * story than editing code in front of judges.
 *
 * Groq is the default upstream and needs no adapter — it *is* OpenAI-compatible,
 * so it rides the `callOpenAI` path with nothing but a different base URL. It is
 * the right default for one reason: this is a voice game show under a countdown,
 * so time-to-first-token is what the audience actually perceives, and Groq wins
 * that by a wide margin. Anthropic is the quality failover, for when Hinglish or
 * answer-judging needs more headroom than an open model has.
 *
 * Note what is deliberately absent: deep reasoning. Turns here are one or two
 * spoken sentences under a six-minute countdown, so time-to-first-token
 * dominates and thinking would trade the thing that matters for the thing that
 * does not. Measured on Groq, 23 Aug 2026: gpt-oss-120b at reasoning_effort
 * "low" answered in 581ms; the same model at "medium" took 1072ms and started
 * leaking the answer into its hints.
 */

import { optional, required } from "./env";

/** The internal message shape, which is the OpenAI one. */
export type Message = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type UpstreamReply = {
  content: string;
  toolCalls: ToolCall[];
};

/**
 * Which wire format to speak upstream.
 *
 * Only two exist here, because only two matter: Anthropic's Messages API, and
 * the OpenAI `/chat/completions` shape that Groq, OpenAI and Azure all
 * implement. "groq" is deliberately not its own branch — treating it as
 * OpenAI-compatible is not a shortcut, it is simply what it is.
 */
function provider(): "anthropic" | "openai" {
  const explicit = optional("LLM_PROVIDER", "").toLowerCase();
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "openai" || explicit === "groq") return "openai";
  // Infer from the URL so one env var is enough to switch.
  return optional("LLM_UPSTREAM_URL", "").includes("anthropic")
    ? "anthropic"
    : "openai";
}

export async function callUpstream(
  messages: Message[],
  tools: ToolDefinition[],
): Promise<UpstreamReply> {
  return provider() === "anthropic"
    ? callAnthropic(messages, tools)
    : callOpenAI(messages, tools);
}

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible                                                          */
/* -------------------------------------------------------------------------- */

async function callOpenAI(
  messages: Message[],
  tools: ToolDefinition[],
): Promise<UpstreamReply> {
  const res = await fetch(
    optional(
      "LLM_UPSTREAM_URL",
      "https://api.groq.com/openai/v1/chat/completions",
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${required("LLM_API_KEY")}`,
      },
      body: JSON.stringify({
        model: optional("LLM_MODEL", "openai/gpt-oss-120b"),
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.7,
        /**
         * Deliberately generous, and it is not about output length.
         *
         * Reasoning models bill their private reasoning against this ceiling
         * before emitting a single visible token. At 320 a model like
         * qwen3.6-27b spends the entire budget thinking and returns an *empty*
         * turn — the host silently says nothing, with no error anywhere. The
         * visible reply is still one or two sentences; this is headroom for the
         * part we do not see.
         */
        max_tokens: Number(optional("LLM_MAX_TOKENS", "1024")),
        /**
         * Groq-specific, for the gpt-oss family. Omitted entirely when unset so
         * this same code path still works against OpenAI proper and any other
         * OpenAI-compatible endpoint that would reject the field.
         */
        ...(optional("LLM_REASONING_EFFORT", "")
          ? { reasoning_effort: optional("LLM_REASONING_EFFORT", "low") }
          : {}),
      }),
    },
  );

  if (!res.ok) throw new Error(`Upstream LLM ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    choices: { message: Message }[];
  };
  const reply = json.choices[0]?.message;

  return {
    content: sanitizeSpoken(reply?.content ?? ""),
    toolCalls: reply?.tool_calls ?? [],
  };
}

/**
 * Remove reasoning that leaked into the visible reply.
 *
 * Some models on Groq return their chain of thought inside `<think>` tags in
 * `content` rather than in the separate `reasoning` field — qwen3.6-27b does
 * this. Every character of `content` goes straight to TTS, so without this the
 * host reads its own deliberation aloud to the room, in English, mid-game.
 *
 * Cheap insurance: it is a no-op on models that behave.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // An unclosed tag means the budget ran out mid-thought — drop the tail,
    // because none of it was meant to be spoken.
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/<\/?(?:thinking|reasoning|analysis)>/gi, "")
    .trim();
}

/** Every tool name the host can call — the vocabulary of a leak. */
const TOOL_NAME =
  /\b(?:get_state|select_wire|cut_wire|wrong_answer|get_hint|defer_wire|grant_lifeline|phone_a_friend)\b/gi;

/** The same names with an argument blob hanging off them, written as prose. */
const TOOL_CALL_AS_PROSE =
  /\b(?:get_state|select_wire|cut_wire|wrong_answer|get_hint|defer_wire|grant_lifeline|phone_a_friend)\b\s*[({][^)}]*[)}]?/gi;

/**
 * Argument keys, in every spelling a model mangles them into, paired with
 * whatever value follows. `playerid: 1` and `"answered_by": "p2"` both match.
 */
const ARG_PAIR =
  /["'`]?\b(?:player_?id|answered_?by|answer_?text|tool_?calls?|function|arguments|parameters|recipient|channel|colou?r|wire)\b["'`]?\s*[:=]\s*["'`]?[\w-]*["'`]?,?/gi;

/**
 * Strip machinery that leaked into the spoken turn.
 *
 * Every character of `content` goes two places: the TTS voice, and the
 * transcript on the projector and the host console. So when a model writes its
 * tool call as prose instead of emitting it on the tool channel — `cut_wire
 * {"color": "red"}`, or a bare `playerid: 1` trailing the sentence — it is not
 * a cosmetic glitch. The host reads JSON aloud to the room and the caption shows
 * it to the audience.
 *
 * This happens often enough to design against rather than hope away: the
 * open-weight models on Groq drop into text-mode tool calls whenever a turn
 * mixes speech with an action, which is most turns in this game.
 *
 * Safe to be aggressive, for one reason specific to this host: it speaks
 * Devanagari and nothing else, by standing order. Anything here that matches
 * Latin identifiers and JSON is machinery by definition — there is no line of
 * real dialogue it could be eating.
 */
export function sanitizeSpoken(text: string): string {
  const out = stripReasoning(text)
    // Harmony framing: <|start|>assistant<|channel|>commentary<|message|>…
    // A bare Latin word sandwiched between two markers is a channel name, not
    // speech, so it goes with the markers rather than being left behind.
    .replace(/<\|[^|>]*\|>[ \t]*[A-Za-z_]*[ \t]*(?=<\|)/g, " ")
    // Whatever markers remain.
    .replace(/<\|[^|>]*\|>/g, " ")
    // <tool_call>…</tool_call>, <function=cut_wire>…</function>, and the
    // half-closed variants a truncated turn leaves behind.
    .replace(/<\/?(?:tool_call|tool_response|function|invoke)[^>]*>/gi, " ")
    // Fenced blocks — a model asked for JSON often reaches for markdown.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/g, " ")
    // `cut_wire({...})` or `cut_wire {"color": "red"}` written out as prose.
    .replace(TOOL_CALL_AS_PROSE, " ")
    // A bare JSON object. One level deep and non-greedy, which is the shape a
    // leaked tool argument actually takes.
    .replace(/\{[^{}]*[:=][^{}]*\}/g, " ")
    // The residue once the braces are gone: `player_id: p1`, `playerid = 1`,
    // `"answered_by": "p2"`, with or without the trailing comma.
    .replace(ARG_PAIR, " ")
    // A tool name left standing on its own after its arguments were removed.
    .replace(TOOL_NAME, " ")
    // Punctuation orphaned by the removals, then whitespace.
    .replace(/[ \t]*[{}[\]"'`]+[ \t]*/g, " ")
    .replace(/\s*,\s*(?=[।?!,]|$)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  /**
   * If nothing with a letter in it survived, the whole turn was machinery.
   *
   * Returning "" rather than the leftovers is the right answer: an empty turn
   * is silence, and silence beats the host reading ": 1" to the room.
   */
  return /\p{L}/u.test(out) ? out : "";
}

/* -------------------------------------------------------------------------- */
/* Anthropic Messages API                                                     */
/* -------------------------------------------------------------------------- */

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/**
 * Translate the OpenAI-shaped history into Anthropic's.
 *
 * Three structural differences to bridge:
 *   - system prompts are a top-level `system` string, not messages
 *   - tool calls are `tool_use` content blocks on the assistant turn
 *   - tool results are `tool_result` blocks on a *user* turn, not role "tool"
 *
 * Consecutive tool results have to be merged into one user turn, because
 * Anthropic rejects two user messages in a row.
 */
function toAnthropic(messages: Message[]) {
  const systemParts: string[] = [];
  const out: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];

  const pushBlock = (role: "user" | "assistant", block: AnthropicBlock) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      pushBlock("user", {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "unknown",
        content: message.content ?? "",
      });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        pushBlock("assistant", { type: "text", text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Malformed arguments are the model's problem to recover from.
        }
        pushBlock("assistant", {
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      continue;
    }

    pushBlock("user", { type: "text", text: message.content ?? "" });
  }

  // Anthropic requires the conversation to open on a user turn.
  while (out.length && out[0].role === "assistant") out.shift();

  return { system: systemParts.join("\n\n"), messages: out };
}

async function callAnthropic(
  messages: Message[],
  tools: ToolDefinition[],
): Promise<UpstreamReply> {
  const { system, messages: converted } = toAnthropic(messages);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": required("LLM_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: optional("LLM_MODEL", "claude-sonnet-5"),
      max_tokens: Number(optional("LLM_MAX_TOKENS", "1024")),
      temperature: 0.7,
      system,
      messages: converted,
      tools: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })),
    }),
  });

  if (!res.ok) throw new Error(`Upstream LLM ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    content: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[];
    stop_reason?: string;
  };

  const text = json.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  const toolCalls: ToolCall[] = json.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? `call_${Math.random().toString(36).slice(2)}`,
      type: "function" as const,
      function: {
        name: b.name ?? "",
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  return { content: sanitizeSpoken(text), toolCalls };
}

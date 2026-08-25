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

/**
 * The upstream model, and why the default is a llama and not a gpt-oss.
 *
 * This default used to be `openai/gpt-oss-120b`, which contradicted both
 * `.env.example` and the verified note in AGENTS.md that says to avoid the
 * gpt-oss family *in this project specifically*. The reason is this file's
 * whole purpose: the host does not merely talk, it has to decide to call
 * `cut_wire`, and a brain that chats instead of acting is indistinguishable on
 * stage from a broken wire panel. The contestant answers correctly, the host
 * agrees out loud, and nothing is cut — which is the bug the room actually
 * sees.
 *
 * `llama-3.3-70b-versatile` is the balanced pick and the one `.env.example`
 * already documents: parallel tool calls, decent Hindi, still fast enough that
 * time-to-first-token does not suffer.
 */
function LLM_MODEL(): string {
  return optional("LLM_MODEL", "llama-3.3-70b-versatile");
}

/**
 * The models that accept `reasoning_effort`. Groq's gpt-oss family only.
 *
 * Kept as a pattern rather than a list so a future `gpt-oss-*` size does not
 * silently lose the setting.
 */
const REASONING_MODEL = /gpt-oss/i;

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
        model: LLM_MODEL(),
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
         * Groq-specific, for the gpt-oss family — and now actually gated on
         * that family rather than merely documented as being for it.
         *
         * The old condition was "is `LLM_REASONING_EFFORT` set", which made
         * changing `LLM_MODEL` in `.env.local` a two-line change that looked
         * like a one-line change: leave the effort variable behind and a
         * gpt-oss-only parameter goes to a model that does not take it. Omitted
         * entirely otherwise, so this same path still works against OpenAI
         * proper and any other OpenAI-compatible endpoint.
         */
        ...(REASONING_MODEL.test(LLM_MODEL()) &&
        optional("LLM_REASONING_EFFORT", "")
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


/* -------------------------------------------------------------------------- */
/* Narrated actions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Catch the host announcing something he never did.
 *
 * # The failure this exists for
 *
 * Observed live, from the event log of a real round:
 *
 *   +175.7s  host_said  "बिलकुल सही! सफ़ेद तार कट गया। सभी पाँच तार कट गए — आप जीत गए"
 *   +336.8s  wire_cut   color=white
 *
 * The model announced the cut and the win, in character, convincingly — and
 * never called `cut_wire`. It then spent a hundred and sixty seconds repeating
 * that the team had won, because as far as it was concerned the wire was already
 * cut and there was nothing left to do. The contestant had to keep insisting
 * before it finally performed the action it had already claimed to have taken.
 *
 * No amount of prompting reliably fixes this, and no amount of state injection
 * does either: LIVE STATE was correct the whole time and told it four wires were
 * cut. The model simply asserted otherwise. The only thing that can stop the
 * words reaching the room is checking them against the state before they are
 * spoken, which is what this does.
 *
 * # Why this is not overreach
 *
 * It is the same job `sanitizeSpoken` already does — remove text that must not
 * be spoken — applied to a different class of impossible output. A leaked tool
 * call is machinery the audience should not hear; a false win is a statement the
 * screens will contradict in front of everybody. Both are the model saying
 * something the server knows to be untrue.
 *
 * Deliberately narrow. It fires only on a claim that contradicts server state:
 * a colour named as cut when that wire is not cut, or a win claimed while the
 * round is running. Saying "लाल तार कट गया" about a genuinely cut red wire
 * passes untouched, and so does everything else the host ever says.
 */

/**
 * Devanagari for "cut", in the forms a host actually uses.
 *
 * Note `गए` — it is ग + ए, a separate vowel letter, NOT ग + य. The first version
 * of this matched only `गय` and so was blind to "कट गए", which is the commonest
 * form there is and the exact wording of the line that prompted all of this. A
 * detector that cannot see its own motivating example is worse than none, so the
 * completive endings are spelled out rather than approximated.
 */
const CUT_VERB =
  /(कट\s*(गया|गये|गए|गई|गईं)|कट\s*चुक|काट\s*(दिया|दिये|दिए|दी|दीं)|काट\s*चुक|कटा\s)/;

/**
 * Devanagari for "won", completive only.
 *
 * Deliberately not a bare `जीत`: "जीतने के लिए एक तार बाकी है" — one wire left to
 * win — is a perfectly true and useful thing for the host to say, and blocking it
 * would make the guard worse than the bug. Only a *completed* win is a claim.
 */
const WIN_CLAIM =
  /(जीत\s*(गया|गये|गए|गई|लिया|लिये|लिए|हुई|हुआ|आपके)|आप\s*जीत|डिफ्यूज|बम\s*बच)/;

export type ClaimCheck =
  | { ok: true }
  | { ok: false; reason: string; correction: string };

export function checkSpokenClaims(
  text: string,
  state: {
    /** Devanagari names of wires that really are cut. */
    cutDev: string[];
    /** Devanagari names of wires still to cut. */
    remainingDev: string[];
    phase: string;
  },
): ClaimCheck {
  if (!text.trim()) return { ok: true };

  const remainingList = state.remainingDev.join(", ");
  const stillToCut =
    state.remainingDev.length === 1
      ? `अभी ${remainingList} तार बाकी है`
      : `अभी ${state.remainingDev.length} तार बाकी हैं — ${remainingList}`;

  /* -- a win that has not happened --------------------------------------- */
  if (WIN_CLAIM.test(text) && state.phase !== "won") {
    return {
      ok: false,
      reason: `claimed a win while the round is ${state.phase} with ${state.remainingDev.length} wire(s) still to cut`,
      correction: `एक मिनट — ${stillToCut}। चलिए, जवाब बताइए।`,
    };
  }

  /* -- a cut that has not happened --------------------------------------- */
  if (CUT_VERB.test(text)) {
    for (const dev of state.remainingDev) {
      if (text.includes(dev)) {
        return {
          ok: false,
          reason: `claimed the ${dev} wire was cut, but it is not`,
          correction: `एक मिनट — ${dev} तार अभी कटा नहीं है। जवाब फिर से बताइए।`,
        };
      }
    }
    /**
     * "सभी पाँच तार कट गए" names no colour, so the loop above cannot catch it.
     * A claim that everything is cut is false whenever anything remains.
     */
    if (/(सभी|सारे|पाँचों|पाँच)/.test(text) && state.remainingDev.length > 0) {
      return {
        ok: false,
        reason: `claimed every wire was cut with ${state.remainingDev.length} still to cut`,
        correction: `एक मिनट — ${stillToCut}। चलिए, जवाब बताइए।`,
      };
    }
  }

  return { ok: true };
}

/**
 * The browser half of the pre-flight check.
 *
 *   npm run check:browser
 *
 * # Why this exists
 *
 * `npm run check` asserts the rules and the pure functions, and it cannot reach
 * the thing that actually breaks on stage: a projector that loads, joins the
 * channel, and quietly fails to do one of the four things it is there for. Every
 * seam this drives is one that fails *silently* —
 *
 *   - the page renders but the WebGL scene throws, so the room sees a black wall
 *   - RTC joins but RTM does not, so nothing reports what the host really said
 *     and the subtitles fall back to timing themselves off an audio level
 *   - the agent never arrives, and the projector looks fine while the room sits
 *     in silence
 *
 * None of those produce a non-zero exit code anywhere. This turns them into one.
 *
 * # What it deliberately does NOT assert
 *
 * That the host says anything sensible, or that the subtitle matches it word for
 * word. Both need ears. This checks that the machinery is connected; a rehearsal
 * checks that it is good.
 *
 * # Cost
 *
 * Pressing start joins a real Agora agent, which spends real Agora, Groq and
 * Sarvam quota. It is a few seconds of one agent, and the agent is stopped
 * before this exits — including when an assertion fails, which is the case that
 * would otherwise leave one running.
 */

import { chromium, type ConsoleMessage } from "playwright";

const BASE = process.env.CHECK_BASE_URL ?? "http://localhost:3000";

/**
 * How long to wait for the ack transport.
 *
 * The reporter has to import two SDKs, log into RTM, and post its first
 * heartbeat, and the ledger only leaves degraded mode on that heartbeat. Twenty
 * seconds is far longer than that path takes when it works, and short enough
 * that a failure is reported rather than waited on.
 */
const ACK_TIMEOUT_MS = 45_000;

/**
 * Twenty seconds was not enough, and the reason is worth writing down.
 *
 * The reporter dynamically imports `agora-rtm` and the ConvoAI toolkit, and in
 * `next dev` the first page load after an edit compiles and bundles both before
 * a single line of that code runs. A run right after a change would fail here
 * and then pass every assertion below it — the acks arriving moments after this
 * one had already given up. A check that fails on its own impatience trains you
 * to ignore it, which is worse than not having it.
 */

/** How long to wait for the agent to actually appear in the channel. */
const AGENT_TIMEOUT_MS = 25_000;

let failures = 0;
function ok(label: string) {
  console.log(`  ok   ${label}`);
}
function fail(label: string, detail = "") {
  failures++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  return (await res.json()) as T;
}

/** Poll until `test` passes or the deadline expires. Returns the last value. */
async function until<T>(
  fetcher: () => Promise<T>,
  test: (v: T) => boolean,
  timeoutMs: number,
): Promise<{ passed: boolean; value: T }> {
  const deadline = Date.now() + timeoutMs;
  let value = await fetcher();
  while (Date.now() < deadline) {
    if (test(value)) return { passed: true, value };
    await new Promise((r) => setTimeout(r, 700));
    value = await fetcher();
  }
  return { passed: test(value), value };
}

type Health = {
  ready: boolean;
  blocking: string[];
  rooms: {
    code: string;
    degraded: boolean;
    reporterError: string | null;
    speech: Record<string, number>;
  }[];
};

async function main() {
  console.log("\nKKT browser check\n");
  console.log(`base ${BASE}`);

  /* -- the server has to be up first ------------------------------------- */
  let health: Health;
  try {
    health = await json<Health>("/api/health");
  } catch {
    console.log(`\n  FAIL cannot reach ${BASE} — is the dev server running?\n`);
    process.exit(1);
  }
  if (!health.ready) {
    fail("server reports ready", health.blocking.join("; "));
  } else {
    ok("server reports ready");
  }

  /* -- a fresh room ------------------------------------------------------- */
  const created = (await (
    await fetch(`${BASE}/api/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json()) as { code: string };
  const code = created.code;

  /**
   * Seat two contestants before opening the projector.
   *
   * Not decoration: the start control is disabled and reads "Waiting for
   * players…" in an empty room, so without this the check waits twenty seconds
   * for a button that is deliberately unclickable and reports a failure that
   * says nothing about the code. Two rather than one, because a solo round takes
   * a different path through `startGame` and the multi-contestant one is what a
   * demo actually runs.
   */
  for (const name of ["Rahul", "Priya"]) {
    await fetch(`${BASE}/api/room/${code}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }
  console.log(`room ${code} — two contestants seated`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      // The scene is WebGL. Headless Chromium needs a software rasteriser, and
      // without one the canvas throws and the whole React tree unmounts — which
      // would make every check below fail for the wrong reason.
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
      // The projector plays the host through the room speakers, so it must be
      // allowed to start audio without a click.
      "--autoplay-policy=no-user-gesture-required",
      // Agora's RTC client wants a media device to exist even when publishing
      // nothing, and CI machines have none.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });

  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();

  /** Everything the page said. This is where a swallowed RTM failure shows up. */
  const logs: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    const line = `${m.type()}: ${m.text()}`;
    logs.push(line);
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    await page.goto(`${BASE}/stage/${code}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    ok("projector page loads");

    /**
     * Press whatever starts the round.
     *
     * Matched by accessible name rather than by a test id, deliberately: a test
     * id would keep passing after the button stopped being findable by a human,
     * which is the failure that matters on a laptop nobody has used before.
     */
    const start = page
      .getByRole("button", { name: /start the game/i })
      .first();
    await start.click({ timeout: 20_000 });
    ok("the start control is reachable and clickable");

    /* -- the ack transport ---------------------------------------------- */
    const acks = await until<Health>(
      () => json<Health>("/api/health"),
      (h) => h.rooms.some((r) => r.code === code && !r.degraded),
      ACK_TIMEOUT_MS,
    );
    const room = acks.value.rooms.find((r) => r.code === code);
    if (acks.passed) {
      ok("RTM connected — the ledger is taking acks, not estimating");
    } else if (room?.reporterError) {
      fail("RTM connected", `reporter said: ${room.reporterError}`);
    } else {
      fail(
        "RTM connected",
        "no heartbeat and no error — the reporter never ran at all",
      );
    }

    /* -- the host actually turns up -------------------------------------- */
    const agent = await until<{ agentId: string | null }>(
      () => json<{ agentId: string | null }>(`/api/room/${code}/agent`),
      (a) => !!a.agentId,
      AGENT_TIMEOUT_MS,
    );
    /**
     * Agora's own view, not ours.
     *
     * Our agent map holds an id from the moment `/join` returns 200, which says
     * the request was accepted and nothing more. An agent that then fails on
     * Agora's side — a rejected token, a provider it cannot reach — leaves that
     * id sitting there looking healthy, which is precisely the "the projector
     * says fine and the room sits in silence" failure.
     */
    if (agent.value.agentId) {
      const status = await json<{ status?: unknown; error?: string }>(
        `/api/room/${code}/agent/status`,
      ).catch(() => ({ status: "unqueryable" }) as { status: unknown });
      console.log(`       agora says the agent is: ${String(status.status)}`);
    }
    if (agent.passed) ok("the host joined the channel");
    else fail("the host joined the channel", "no agent id was ever registered");

    /**
     * The payoff: a real ack, not just a heartbeat.
     *
     * Everything above proves the transport is up. This proves it carries what
     * it is for. The greeting is registered the instant Agora accepts the
     * `/join`, then Sarvam has to return audio and the agent has to publish a
     * transcript for it — so a `speaking` or `ended` status on the host's first
     * line means the entire chain closed: registered here, spoken there,
     * observed by the browser, reported back, applied to the ledger.
     *
     * It also settles the question AGENTS.md flags as an hour-one experiment. The
     * reporter only forwards items whose uid matches the agent, so an ack landing
     * at all means that uid does distinguish the agent from the humans.
     *
     * Generous timeout: this waits on TTS on a cold start, which is the same
     * reason `startDeadlineMs` gives the greeting six seconds.
     */
    const spoken = await until<{
      host: { current: { id: string; status: string; spoken: string | null } | null };
    }>(
      () => json(`/api/room/${code}`),
      (v) =>
        !!v.host.current &&
        ["speaking", "ended", "interrupted"].includes(v.host.current.status),
      /**
       * Generous, and the reason is the finding itself.
       *
       * In TEXT render mode the transcript for a turn arrives when the turn
       * ENDS, not while it is running. The opening greeting is a paragraph —
       * intro, rules and the first riddle — so its transcript lands forty-odd
       * seconds after the host starts talking. Earlier runs passed in thirty
       * seconds only because a dead tunnel made him say the short failure line
       * instead.
       */
      90_000,
    );
    const cur = spoken.value.host.current;
    if (spoken.passed) {
      ok(
        `a real line was acknowledged — ${cur!.id} is "${cur!.status}"` +
          (cur!.spoken ? `, transcript: "${cur!.spoken.slice(0, 40)}…"` : ""),
      );
    } else {
      fail(
        "a real line was acknowledged",
        `the host's line is still "${cur?.status ?? "absent"}" — the transport is up but no transcript reached it`,
      );
    }

    /**
     * The intended line and the spoken line are the SAME record.
     *
     * The assertion above passes as long as something was acknowledged, and that
     * is not enough: a transcript that fails to match the line we registered
     * produces a second `unattributed` record and leaves the original `pending`
     * until it is abandoned. The ledger then reports a divergence it invented
     * itself, which is worse than no ledger — it would have the host re-speak a
     * line the room already heard.
     */
    const ledger = await json<Health>("/api/health");
    const mine = ledger.rooms.find((r) => r.code === code);
    if (mine && mine.speech.unattributed === 0 && mine.speech.pending === 0) {
      ok("the line we registered is the line that got acknowledged");
    } else {
      fail(
        "the line we registered is the line that got acknowledged",
        `unattributed=${mine?.speech.unattributed} pending=${mine?.speech.pending} — the transcript did not match its own registration`,
      );
    }

    /**
     * The agent's own error channel.
     *
     * `enable_error_message: true` makes Agora report module failures to the
     * client, and an `llm` error is fatal to the game even though everything
     * else here passes: the agent is RUNNING, it speaks, it publishes
     * transcripts — and every single line is the failure message, because it
     * cannot reach `llm.url`. A stale cloudflared hostname does exactly this,
     * which is the whole reason the tunnel is verified rather than pasted.
     *
     * Worth failing on. Discovering it here costs a minute; discovering it in
     * front of judges costs the demo.
     */
    // ">>> agent-error" is the toolkit emitting one. A line merely containing
    // "agent-error" can be it announcing that a handler was registered, which is
    // evidence of health being reported as a failure.
    const agentErrors = logs.filter((l) => l.includes(">>> agent-error"));
    if (agentErrors.length === 0) {
      ok("the agent reported no module errors");
    } else {
      const llm = agentErrors.find((l) => l.includes('"type":"llm"'));
      fail(
        "the agent reported no module errors",
        llm
          ? `the host cannot reach the LLM proxy — every line will be the failure message. Renew the tunnel (npm run tunnel). ${llm.slice(0, 160)}`
          : agentErrors[0].slice(0, 200),
      );
    }

    /* -- nothing threw --------------------------------------------------- */
    if (pageErrors.length === 0) ok("no uncaught errors on the page");
    else fail("no uncaught errors on the page", pageErrors[0]);

    /**
     * Only error-level lines count as a complaint.
     *
     * This matched any `[kkt-rtm]` line at first, which meant the reporter's own
     * "login resolved" and "subscribed" debug lines — the ones proving it was
     * working — were reported as failures. An assertion that fires on evidence of
     * success is worse than no assertion.
     */
    const rtmComplaints = logs.filter(
      (l) => l.includes("[kkt-rtm]") && l.startsWith("error:"),
    );
    if (rtmComplaints.length === 0) ok("the transcript reporter did not complain");
    else fail("the transcript reporter did not complain", rtmComplaints[0]);
  } finally {
    /**
     * Stop the agent whatever happened.
     *
     * In a `finally` because the failure paths are exactly the ones that would
     * otherwise leave an agent sitting in a channel talking to an empty room
     * until its idle timeout — billed, and confusing to whoever opens the room
     * next.
     */
    await fetch(`${BASE}/api/room/${code}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => {});
    await browser.close();
  }

  /**
   * Errors from the page, always — not only when something failed.
   *
   * Agora logs plenty that is not fatal, and a run that passes while quietly
   * printing "token expired" is worth seeing before a rehearsal rather than
   * during one.
   */
  /**
   * The reporter's own account of what it saw.
   *
   * Printed whenever anything failed, because "no transcript reached the ledger"
   * has several very different causes — nothing published, published under an
   * unexpected uid, or published and filtered out here — and only these lines
   * tell them apart.
   */
  {
    const rtm = logs.filter((l) => l.includes("[kkt-rtm]"));
    console.log(`
transcript reporter said (${rtm.length} lines):`);
    for (const l of rtm.slice(0, 12)) console.log(`  ${l.slice(0, 300)}`);
    if (rtm.length === 0) console.log("  (nothing — it never received an update)");
  }

  const errors = logs.filter((l) => l.startsWith("error:"));
  if (errors.length) {
    console.log("\nbrowser console errors:");
    for (const e of errors.slice(0, 8)) console.log(`  ${e.slice(0, 220)}`);
  }

  console.log(
    `\n${failures === 0 ? "browser check passed" : `${failures} browser check(s) FAILED`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

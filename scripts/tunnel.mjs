#!/usr/bin/env node
/**
 * Renew the cloudflared quick tunnel and repoint PUBLIC_BASE_URL at it.
 *
 * A quick tunnel gets a new random hostname every time cloudflared starts, and
 * nothing in this project notices when the old one dies. Agora is handed a
 * stale `llm.url`, Vobiz is handed a stale `answer_url`, and Vobiz *skips audio
 * it cannot fetch without erroring* — so the failure mode is not an exception,
 * it is a silent dead-air call. That is what this script exists to prevent.
 *
 * `.env.local` is the single place the URL is stored. Everything else derives
 * it at request time (lib/env.ts, lib/game/lifeline.ts, app/api/join-url), so
 * rewriting that one line is the whole update.
 *
 * Usage: node scripts/tunnel.mjs [--port 3000] [--keep-alive] [--wait 180]
 *   --keep-alive   leave an already-healthy tunnel alone instead of recycling it
 *   --wait N       wait up to N seconds for the dev server instead of giving up
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local");
// Two constraints pick this path. Not under .next/ — the dev server wipes its
// own cache directory out from under you, and a log that vanishes mid-read
// looks exactly like a tunnel that never printed a hostname. And unique per
// run — a still-running cloudflared keeps a write handle on its log, which
// makes the next run's `> file` redirect fail to open, so that tunnel dies
// before printing anything. Both failures present identically: an empty log.
let LOG_FILE = join(ROOT, `.tunnel.${process.pid}.log`);
const KEY = "PUBLIC_BASE_URL";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const PORT = Number(flag("port", 3000));
const KEEP_ALIVE = args.includes("--keep-alive");
const WAIT_SECONDS = Number(flag("wait", 0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(msg);
const die = (msg) => {
  console.error(`\n  FAILED  ${msg}\n`);
  process.exit(1);
};

/** The dev server must already be up: cloudflared will happily tunnel to a
 *  closed port, and then every request through it 502s. */
async function devServerIsUp() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok || res.status === 503; // 503 = running but not ready; still up
  } catch {
    return false;
  }
}

function killExistingTunnels() {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "ignore" });
    } else {
      execFileSync("pkill", ["-f", "cloudflared tunnel"], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false; // nothing was running; that is the normal case
  }
}

/** Best-effort tidy-up of previous runs' logs. Any still held by a live tunnel
 *  stay put; that is not worth failing over. */
function sweepOldLogs() {
  for (const name of readdirSync(ROOT)) {
    if (/^\.tunnel\.\d+(?:\.\d+)?\.log$/.test(name) && join(ROOT, name) !== LOG_FILE) {
      try {
        unlinkSync(join(ROOT, name));
      } catch {
        /* still held by a live tunnel */
      }
    }
  }
}

/** Two things here are load-bearing, each learned by watching it fail:
 *
 *  1. `detached` is set only off Windows. A detached child on Windows gets its
 *     own console and its output never reaches the inherited descriptor — the
 *     tunnel comes up fine and the log stays empty forever. Windows does not
 *     kill children when the parent exits, so `unref()` alone keeps it alive.
 *  2. An `error` listener. Without one a failed spawn is completely silent —
 *     it surfaces 60s later as "no hostname", which points the blame at
 *     cloudflared rather than at the spawn that never happened.
 */
function startTunnel() {
  const fd = openSync(LOG_FILE, "a");
  const child = spawn("npx", ["cloudflared", "tunnel", "--url", `http://localhost:${PORT}`], {
    detached: process.platform !== "win32",
    shell: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.on("error", (err) => die(`could not start cloudflared: ${err.message}`));
  child.unref();
}

/** cloudflared prints the assigned hostname inside a banner a few seconds after
 *  start. Read it out of the log rather than the pipe, so the tunnel outlives
 *  this process. */
async function readAssignedUrl(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) return match[0];
    if (/failed to (request|connect)|Unauthorized/i.test(log)) {
      die(`cloudflared could not open a tunnel. Log: ${LOG_FILE}`);
    }
    await sleep(1000);
  }
  die(`cloudflared printed no hostname in ${timeoutMs / 1000}s. Log: ${LOG_FILE}`);
}

function writeEnv(url) {
  if (!existsSync(ENV_FILE)) die(`${ENV_FILE} does not exist. Copy .env.example first.`);
  const before = readFileSync(ENV_FILE, "utf8");
  const line = `${KEY}=${url}`;
  const previous = before.match(new RegExp(`^${KEY}=(.*)$`, "m"))?.[1]?.trim() ?? null;
  const after =
    previous === null
      ? `${before.replace(/\s*$/, "")}\n${line}\n`
      : before.replace(new RegExp(`^${KEY}=.*$`, "m"), line);
  writeFileSync(ENV_FILE, after);
  return previous;
}

/** Cloudflare hands out a hostname before it is certain to publish it, and
 *  sometimes never publishes it at all — reliably enough after several tunnels
 *  in quick succession that it cannot be left as a manual retry. Any HTTP
 *  response at all, even a 502, proves the name resolves and the edge is
 *  routing; that is all this asks. */
async function tunnelIsReachable(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
      return true;
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

/** next dev reloads .env.local on its own, but not instantly. Poll the health
 *  endpoint *through the tunnel* until it reports the new host — that proves
 *  three things at once: tunnel up, dev server reloaded, origin consistent. */
async function waitForHealth(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10000) });
      last = await res.json();
      if (last.publicBaseUrl === url && last.servingHost === new URL(url).host) return last;
    } catch {
      /* tunnel still propagating, or dev server mid-reload */
    }
    await sleep(2000);
  }
  if (last) {
    die(
      `Tunnel is up but /api/health still reports publicBaseUrl=${last.publicBaseUrl}. ` +
        `The dev server did not reload .env.local — restart 'npm run dev'.`,
    );
  }
  die(
    `${url} resolved but never served /api/health within ${timeoutMs / 1000}s. ` +
      `Check that the dev server on :${PORT} is still up.`,
  );
}

/** Vobiz fetches these over the public internet and skips whatever it cannot
 *  get, silently. health's `present` flags are a local-filesystem check, which
 *  is not the same question. Ask the real one. */
async function verifyAudioOverTunnel(url, health) {
  const targets = [
    ...(health.audio?.hints ?? []).map((h) => ({ label: h.riddle, path: h.file })),
    ...(health.audio?.outcome ?? []).map((o) => ({
      label: o.name,
      path: `/audio/outcome/${o.file}`,
    })),
  ];
  const bad = [];
  for (const t of targets) {
    try {
      const res = await fetch(`${url}${t.path}`, { signal: AbortSignal.timeout(20000) });
      const size = Number(res.headers.get("content-length") ?? 0);
      if (!res.ok || size === 0) bad.push(`${t.label} (${res.status}, ${size}b)`);
    } catch (err) {
      bad.push(`${t.label} (${err.message})`);
    }
  }
  return { checked: targets.length, bad };
}

// ---------------------------------------------------------------------------

// `npm run dev` starts this alongside next dev, so the server is usually not up
// yet — hence --wait. Without it, exit rather than tunnel to a closed port,
// which would 502 on every request.
{
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let up = await devServerIsUp();
  if (!up && WAIT_SECONDS > 0) say(`  Waiting for the dev server on :${PORT}...`);
  while (!up && Date.now() < deadline) {
    await sleep(1000);
    up = await devServerIsUp();
  }
  if (!up) {
    die(
      `Nothing is serving http://localhost:${PORT}. Start 'npm run dev' first — ` +
        `a tunnel to a closed port 502s on every request.`,
    );
  }
}

const current = existsSync(ENV_FILE)
  ? readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${KEY}=(.*)$`, "m"))?.[1]?.trim()
  : null;

if (KEEP_ALIVE && current && current.includes("trycloudflare.com")) {
  try {
    const res = await fetch(`${current}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const h = await res.json();
      if (h.publicBaseUrl === current) {
        say(`  Tunnel already healthy: ${current}`);
        say("  (--keep-alive; nothing to do)");
        process.exit(0);
      }
    }
  } catch {
    /* dead — fall through and renew */
  }
}

say(`  Dev server up on :${PORT}`);
if (killExistingTunnels()) say("  Stopped previous cloudflared");

sweepOldLogs();

// `.env.local` is only rewritten once a hostname has proven itself reachable.
// Writing first would trade a known-dead URL for an unknown-dead one.
const ATTEMPTS = 3;
let url = null;
for (let attempt = 1; attempt <= ATTEMPTS && !url; attempt++) {
  LOG_FILE = join(ROOT, `.tunnel.${process.pid}.${attempt}.log`);
  if (attempt > 1) killExistingTunnels();
  startTunnel();
  const candidate = await readAssignedUrl();
  say(`  Tunnel:  ${candidate}`);
  if (await tunnelIsReachable(candidate)) {
    url = candidate;
  } else if (attempt < ATTEMPTS) {
    say(`  ${new URL(candidate).host} never appeared in DNS — Cloudflare does that`);
    say(`  sometimes. Discarding it and asking for another hostname.`);
  }
}
if (!url) {
  die(
    `Cloudflare handed out ${ATTEMPTS} quick-tunnel hostnames and published none ` +
      `of them in DNS. That usually means too many tunnels in a short window — ` +
      `wait a few minutes and try again. ${KEY} has been left untouched.`,
  );
}

const previous = writeEnv(url);
say(previous && previous !== url ? `  Replaced ${KEY} (was ${previous})` : `  Set ${KEY}`);

const health = await waitForHealth(url);
const audio = await verifyAudioOverTunnel(url, health);

say("");
say(`  PUBLIC_BASE_URL  ${url}`);
say(
  `  health           ready=${health.ready} blocking=${health.blocking.length} ` +
    `warnings=${health.warnings.length}`,
);
say(`  audio            ${audio.checked - audio.bad.length}/${audio.checked} fetchable over the tunnel`);
say(`  log              ${LOG_FILE}`);

for (const w of health.warnings) say(`\n  WARNING  ${w}`);
for (const b of health.blocking) say(`\n  BLOCKING ${b}`);
if (audio.bad.length) {
  say(`\n  UNREACHABLE AUDIO (Vobiz will play dead air): ${audio.bad.join(", ")}`);
}

const clean = health.ready && audio.bad.length === 0 && health.blocking.length === 0;
say(clean ? "\n  Ready.\n" : "\n  Tunnel renewed, but the checks above need attention.\n");
process.exit(clean ? 0 : 1);

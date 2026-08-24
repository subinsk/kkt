#!/usr/bin/env node
/**
 * `npm run dev` — the dev server plus a freshly-pointed tunnel.
 *
 * These two are one step, not two, because the gap between them is where the
 * project breaks. A quick tunnel's hostname changes every start, `PUBLIC_BASE_URL`
 * keeps yesterday's, and nothing errors: Agora gets a dead `llm.url`, Vobiz gets
 * a dead `answer_url` and skips hint audio it cannot fetch. You find out when the
 * host says nothing on a live call. Starting the server without renewing the
 * tunnel is the setup for that failure, so this script does not let you.
 *
 * next dev runs in the foreground and owns the console. The tunnel work runs
 * beside it and prints its own summary once the server answers.
 */
import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const passthrough = process.argv.slice(2);

/** `npm run dev -- -p 3010` has to move the tunnel too. A tunnel pointed at a
 *  port nothing is serving 502s on every request, and looks from the outside
 *  exactly like a stale hostname. */
function portFrom(argv) {
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].match(/^(?:-p|--port)=(\d+)$/);
    if (eq) return eq[1];
    if (/^(?:-p|--port)$/.test(argv[i]) && /^\d+$/.test(argv[i + 1] ?? "")) return argv[i + 1];
  }
  return "3000";
}

const PORT = portFrom(passthrough);

const next = spawn("npx next dev", passthrough, {
  cwd: ROOT,
  shell: true,
  stdio: "inherit",
});

// --wait: the server is still compiling, so tunnel.mjs must not give up on the
// first probe. Its own health check is what finally confirms the pair is good.
const tunnel = spawn(
  `node "${join(ROOT, "scripts", "tunnel.mjs")}" --port ${PORT} --wait 180`,
  { cwd: ROOT, shell: true, stdio: "inherit" },
);

/** A tunnel outliving the server it points at is worse than no tunnel: the
 *  hostname resolves, requests 502, and the next run has to fight a cloudflared
 *  still holding on. Cloudflare also stops publishing DNS for new quick tunnels
 *  when too many pile up. So take it down with the server. */
function stopTunnel() {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "ignore" });
    } else {
      execFileSync("pkill", ["-f", "cloudflared tunnel"], { stdio: "ignore" });
    }
  } catch {
    /* already gone */
  }
}

next.on("exit", (code, signal) => {
  tunnel.kill();
  stopTunnel();
  process.exit(signal ? 1 : (code ?? 0));
});

// Ctrl+C reaches both children on its own; this is only so the tunnel is not
// left behind when the parent is killed some other way.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    tunnel.kill();
    stopTunnel();
    process.exit(0);
  });
}

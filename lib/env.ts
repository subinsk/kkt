/**
 * Server-side environment access.
 *
 * Throws at call time rather than at import time, so a missing key surfaces as
 * a readable API error instead of a blank 500 during the demo.
 */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** True when a key is present, for the /api/health readiness check. */
export function isSet(name: string): boolean {
  return Boolean(process.env[name]);
}

/**
 * The origin that Agora's and Vobiz's clouds use to reach *this* process.
 *
 * Not a link to another deployment — every deployment resolves this to its own
 * URL. Three things are built from it and all three fail silently if it is
 * wrong: `llm.url` (Agora fetches it every turn), the Vobiz
 * answer/ring/hangup webhooks, and the hint .wav that `<Play>` fetches.
 *
 * `PUBLIC_BASE_URL` wins when set, because a cloudflared tunnel or a custom
 * domain cannot be derived. Otherwise the host tells us who we are, which
 * removes the deploy-then-set-it-then-redeploy step that is this project's
 * single most repeated mistake:
 *
 *   - `RENDER_EXTERNAL_URL` — Render, full URL including the scheme.
 *   - `VERCEL_PROJECT_PRODUCTION_URL` — Vercel, hostname only, so https:// is
 *     added. The stable production domain, deliberately not `VERCEL_URL`,
 *     which is per-deployment and changes on every push. Requires "Enable
 *     access to System Environment Variables" in project settings.
 *
 * Both verified against vendor docs 23 Aug 2026.
 */
export function resolvePublicBase(): { url: string; source: string } {
  const trim = (v: string) => v.replace(/\/$/, "");

  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return { url: trim(explicit), source: "PUBLIC_BASE_URL" };

  const render = process.env.RENDER_EXTERNAL_URL;
  if (render) return { url: trim(render), source: "RENDER_EXTERNAL_URL" };

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) {
    return {
      url: `https://${trim(vercel)}`,
      source: "VERCEL_PROJECT_PRODUCTION_URL",
    };
  }

  return { url: "", source: "unset" };
}

/** `resolvePublicBase()`, with no trailing slash, throwing if nothing resolves. */
export function publicBaseUrl(): string {
  const { url } = resolvePublicBase();
  if (!url) {
    throw new Error(
      "No public base URL. Set PUBLIC_BASE_URL (locally: npx cloudflared tunnel --url http://localhost:3000). On Render and Vercel this is normally derived from the host automatically.",
    );
  }
  return url;
}

/**
 * The App ID, which both the browser and the server need.
 *
 * `NEXT_PUBLIC_AGORA_APP_ID` is the canonical name because only a NEXT_PUBLIC_
 * variable is inlined into the client bundle. `AGORA_APP_ID` is accepted as a
 * server-side fallback so an existing .env.local does not have to be edited.
 */
export function appId(): string {
  const value =
    process.env.NEXT_PUBLIC_AGORA_APP_ID || process.env.AGORA_APP_ID;
  if (!value) {
    throw new Error(
      "Missing NEXT_PUBLIC_AGORA_APP_ID (the browser needs the NEXT_PUBLIC_ form).",
    );
  }
  return value;
}

export const APP_ID = appId;
export const APP_CERTIFICATE = () => required("AGORA_APP_CERTIFICATE");

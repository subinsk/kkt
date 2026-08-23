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

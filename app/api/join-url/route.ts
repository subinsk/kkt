import { NextResponse } from "next/server";
import { optional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/join-url?code=DEMO — the URL the QR code should encode.
 *
 * The projector cannot work this out for itself. It is usually open on
 * `localhost:3000`, so `window.location.origin` produces a QR pointing at
 * localhost — which resolves to the *phone* when a contestant scans it, and
 * fails. The server is the only side that knows the tunnel exists.
 *
 * Preference order:
 *   1. `PUBLIC_BASE_URL`, when it is a real public host. This is the tunnel
 *      during local development and the service's own URL when deployed.
 *   2. The `Host` header, for a deployment with no explicit base URL set.
 *
 * A localhost value in `PUBLIC_BASE_URL` is deliberately ignored rather than
 * trusted: it is never the right thing to print on a screen for someone to scan.
 */
export async function GET(request: Request) {
  const code = (new URL(request.url).searchParams.get("code") ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const configured = optional("PUBLIC_BASE_URL", "").replace(/\/$/, "");
  const usable =
    configured &&
    !/localhost|127\.0\.0\.1|your-tunnel|example\.com/i.test(configured);

  const base = usable
    ? configured
    : `${request.headers.get("x-forwarded-proto") ?? "https"}://${
        request.headers.get("host") ?? ""
      }`;

  return NextResponse.json({
    base,
    joinUrl: code ? `${base}/join/${code}` : base,
    // Surfaced so the projector can warn rather than print an unscannable QR.
    reachable: !/localhost|127\.0\.0\.1/i.test(base),
  });
}

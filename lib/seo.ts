import { resolvePublicBase } from "./env";

/**
 * Everything the page metadata, the web manifest and the structured data need
 * to agree on, in one place.
 *
 * They have to agree. A manifest whose `name` drifts from the `<title>` and the
 * JSON-LD is how a site ends up with three different names in three different
 * places — the tab, the home-screen icon, and the search result — and nobody
 * notices until it is on a projector in front of judges.
 */

export const SITE_NAME = "Kaun Katega Taarpati";

/** The show's own line. Used where there is room for voice rather than facts. */
export const SITE_TAGLINE = "Paanch taar. Chhe minute. Lock kiya jaye?";

/** ~55 characters, because Google truncates a title around 60. */
export const SITE_TITLE = "Kaun Katega Taarpati — five wires, six minutes";

/** ~140 characters, because Google truncates a description around 160. */
export const SITE_DESCRIPTION =
  "Three players, three phones, five wires and six minutes. Answer the Hinglish paheliyan to cut every wire before the confetti charge goes off.";

/**
 * The origin, for `metadataBase` and the sitemap.
 *
 * Same resolution order as everything else in the app, so Open Graph URLs point
 * at whichever deployment served them. Falls back to localhost rather than
 * throwing: `publicBaseUrl()` is right for a webhook that cannot work without a
 * real origin, but a missing base URL should not take the whole page down.
 *
 * One caveat worth knowing: this is read when the module loads, so a cloudflared
 * tunnel that restarts after the build leaves stale absolute URLs in the
 * `og:image` tags. That costs a link preview, never a round.
 */
export function siteUrl(): string {
  return resolvePublicBase().url || "http://localhost:3000";
}

import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo";

/**
 * Web manifest, served at `/manifest.webmanifest`.
 *
 * Worth having for one specific reason: contestants arrive by scanning a QR
 * code, so every player is already one tap from "Add to Home Screen". With
 * `display: "standalone"` the game opens without a browser chrome bar eating
 * 90px of a phone screen that is showing a countdown.
 *
 * The icons are the wordmark's cut-wire "TA", not the full three-line lockup —
 * eight letters at 192px is a smudge. Deliberately not `purpose: "maskable"`:
 * a circular mask would slice through the letterforms.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: "Taarpati",
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches --ink in globals.css. A blue-black splash behind a warm-black
    // page is visible for the half second it is on screen.
    background_color: "#0a0806",
    theme_color: "#0a0806",
    lang: "en-IN",
    categories: ["games", "entertainment"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

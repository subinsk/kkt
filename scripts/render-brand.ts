/**
 * Cut every brand asset out of the master logo.
 *
 *   npm run render:brand
 *
 * The master is a square 1254×1254 export with dead space around it. Every
 * committed asset is a crop of it, and the crops are measured, not eyeballed —
 * the numbers below came from scanning the master for content bounds, so they
 * are only valid for *that* file. Replace `brand/kkt-logo-master.png` and these
 * become wrong; re-measure before trusting them.
 *
 * Two crops do all the work:
 *
 *   LOCKUP  the full three-line wordmark, trimmed to the brass rules, with the
 *           near-black keyed out so it can sit on the studio set on the landing
 *           page instead of inside a black box.
 *   MARK    "TA" with the severed wire running through the A. This is what
 *           every icon uses. The full lockup is eight letters wide and turns to
 *           mush below about 128px, which is most of the places an icon appears.
 *
 * Needs ffmpeg on PATH. Deliberately not part of `npm run check` — the assets
 * are committed, and a missing logo is loud in a way a missing hint clip is not.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MASTER = "brand/kkt-logo-master.png";

/** Content bounds of the wordmark inside the master, brass rules included. */
const LOCKUP = "crop=1104:678:78:269";

/** The "TA" square. 315px on a side, centred on the TAARPATI line. */
const MARK = "crop=315:315:55:599";

/**
 * The master's background is #040303, not the app's #0a0806, so it keys out as
 * a colour rather than being trimmed. `similarity` is wide enough to catch the
 * antialiasing under the letters and narrow enough to leave the red wire alone;
 * `blend` softens the edge so brass on oxblood has no dark fringe.
 */
const KEY = "format=rgba,colorkey=0x040303:0.16:0.06";

/**
 * 64 colours is generous for a three-colour logo and takes the transparent
 * lockup from 625KB to 55KB. `dither=none` because dithering a flat fill is
 * pure noise, and noise is what costs the bytes.
 */
const QUANTIZE =
  "split[a][b];[b]palettegen=reserve_transparent=1:max_colors=64[p];" +
  "[a][p]paletteuse=alpha_threshold=100:dither=none";

function ff(filter: string, out: string, quiet = false) {
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", MASTER, "-vf", filter, "-frames:v", "1", out],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (!quiet) report(out);
}

function report(path: string) {
  const kb = (statSync(path).size / 1024).toFixed(1);
  console.log(`  ${path.padEnd(34)} ${kb.padStart(7)} KB`);
}

/**
 * The mark at one size. Quantised as well, for the same reason as the lockup:
 * two flat colours plus antialiasing needs nowhere near a full 24-bit palette,
 * and 512px of upscaled brass is otherwise 170KB of gradient nobody can see.
 */
function mark(size: number, out: string, quiet = false) {
  const scale = `scale=${size}:${size}:flags=lanczos`;
  ff(`${MARK},${scale},${QUANTIZE}`, out, quiet);
}

console.log(`\nbrand assets from ${MASTER}\n`);

// --- the wordmark, transparent, for the landing page and both consoles ------
ff(`${LOCKUP},${KEY},${QUANTIZE}`, "public/kkt-logo.png");

// --- icons. Opaque: a transparent app icon composites onto whatever the OS
//     happens to be using, which on iOS is white. -----------------------------
mark(512, "public/icon-512.png");
mark(192, "public/icon-192.png");
mark(180, "app/apple-icon.png");
copyFileSync("public/icon-512.png", "app/icon.png");
report("app/icon.png");

/**
 * favicon.ico, so a bare `/favicon.ico` request does not 404.
 *
 * Hand-assembled because ffmpeg has no ICO muxer. An ICO is a 6-byte header, a
 * 16-byte directory entry and then the image — and since Vista the image is
 * allowed to be a PNG verbatim, which is the whole trick.
 */
const scratch = join(tmpdir(), "kkt-brand");
mkdirSync(scratch, { recursive: true });
const ico32 = join(scratch, "favicon-32.png");
mark(32, ico32, true);

const png = readFileSync(ico32);
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); //  reserved
header.writeUInt16LE(1, 2); //  type: icon
header.writeUInt16LE(1, 4); //  one image
header.writeUInt8(32, 6); //    width
header.writeUInt8(32, 7); //    height
header.writeUInt8(0, 8); //     palette size: not palettised
header.writeUInt8(0, 9); //     reserved
header.writeUInt16LE(1, 10); // colour planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18); // the PNG starts right after this header
writeFileSync("app/favicon.ico", Buffer.concat([header, png]));
report("app/favicon.ico");

/**
 * Social cards. The lockup is 1.63:1 and the card is 1.90:1, so it is fitted by
 * height and centred on the app's ink — never stretched, and never cropped to
 * fill, which would take the brass rules off the top and bottom.
 */
execFileSync(
  "ffmpeg",
  [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=0x0A0806:size=1200x630",
    "-i", "public/kkt-logo.png",
    "-filter_complex",
    "[1]scale=716:440:flags=lanczos[l];[0][l]overlay=(W-w)/2:(H-h)/2",
    "-frames:v", "1",
    "app/opengraph-image.png",
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
report("app/opengraph-image.png");
copyFileSync("app/opengraph-image.png", "app/twitter-image.png");
report("app/twitter-image.png");

console.log("\ndone\n");

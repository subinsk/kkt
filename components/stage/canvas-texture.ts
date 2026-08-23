import * as THREE from "three";

/**
 * Make a CanvasTexture, safely.
 *
 * The scene draws several things — the wall clock, the row numbers on the wire
 * panel — by painting to a 2D canvas and using it as a texture. That is a
 * deliberate choice over 3D text: drei/troika fetches a font file at runtime,
 * and a projector on venue wifi is exactly where that fails and leaves blank
 * rectangles where the countdown should be.
 *
 * The catch is that these are built inside `useMemo`, which does run during
 * server rendering. React Three Fiber does not currently render its children on
 * the server, so in practice this is never reached there — but "in practice" and
 * "a framework internal we do not control" are the same sentence, and a thrown
 * `document is not defined` would take out the whole projector page.
 *
 * So: return a bare texture when there is no DOM, and paint when there is.
 */
export function createCanvasTexture(
  width: number,
  height: number,
  paint?: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void,
): { canvas: HTMLCanvasElement | null; texture: THREE.Texture } {
  if (typeof document === "undefined") {
    return { canvas: null, texture: new THREE.Texture() };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (ctx && paint) paint(ctx, canvas);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, texture };
}

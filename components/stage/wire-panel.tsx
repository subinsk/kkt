"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import { createCanvasTexture } from "./canvas-texture";

/**
 * The wire panel — a framed board mounted on the wall behind the host.
 *
 * Five wires run horizontally across it, numbered 1 to 5 down the left, each
 * terminating in a metal post at either end.
 *
 * Nothing decorative is ever drawn ON a wire. Three rows used to carry an inline
 * "barrel connector" — a dark cylinder laid over the cable as set dressing — and
 * against this matte-black board it read as a GAP, which is the one thing on
 * this panel that already means something: a cut. Four of five rows looked cut
 * when one was. The hardware read now comes from the terminal posts, the
 * mounting plates, the engraved number plates and the sag, none of which can be
 * mistaken for a break in the line.
 *
 * On the wall rather than on the table, which matters for the framing: the
 * camera sits behind the contestants, so a table-top object would be hidden by
 * the backs of their heads. Up on the wall behind the host it is the thing
 * everyone — contestants, host, audience — is looking at.
 *
 * The cut is the payoff beat of the whole game, so it gets the care: white
 * flash, the wire parts at the middle, sparks at the break, the two ends
 * recoiling and sagging. About 400ms.
 */

/**
 * Row order matches the reference: warm at the top, cool below. Our fifth wire
 * is white where the reference used purple — kept white because the phone UI,
 * the host's Hindi ("safed"), and the riddle bank all already agree on it.
 */
const ROWS = ["red", "yellow", "blue", "green", "white"] as const;

const WIRE_HEX: Record<string, string> = {
  red: "#d92b2b",
  yellow: "#e8b62c",
  blue: "#3d7fd9",
  green: "#4fa83d",
  white: "#e8e2d6",
};

/**
 * How far apart the severed ends sit, and how far the free ends hang.
 *
 * Both are deliberately larger than a tidy break would be. A cut wire is the
 * only state on this board that has to be legible from the back of the room, on
 * a projector, in one glance — a hairline gap is not, and it is exactly what a
 * shadow or a piece of set dressing gets mistaken for. The hang stays under the
 * 0.27 row pitch so a drooping end never crosses the wire below it.
 */
const CUT_GAP = 0.17;
const CUT_HANG = 0.15;

export const PANEL_POSITION: [number, number, number] = [0, 1.78, -3.13];
const PANEL_W = 3.5;
const PANEL_H = 1.62;

export function WirePanel({
  game,
  minimal,
}: {
  game: PublicGame;
  minimal: boolean;
}) {
  return (
    <group position={PANEL_POSITION}>
      {/* Outer frame — a deep black box section, like a framed display case. */}
      <mesh position={[0, 0, -0.03]}>
        <boxGeometry args={[PANEL_W + 0.14, PANEL_H + 0.14, 0.1]} />
        <meshStandardMaterial color="#141414" roughness={0.5} metalness={0.35} />
      </mesh>

      {/* Backing board. Matte black so the wires pop against it. */}
      <mesh position={[0, 0, 0.025]}>
        <boxGeometry args={[PANEL_W, PANEL_H, 0.04]} />
        <meshStandardMaterial color="#1c1c1c" roughness={0.92} />
      </mesh>

      {ROWS.map((color, row) => {
        const wire = game.wires.find((w) => w.color === color);
        // Top row first, so row 0 sits highest.
        const y = PANEL_H / 2 - 0.27 - row * 0.27;
        return (
          <WireRow
            key={color}
            color={color}
            row={row}
            y={y}
            status={wire?.status ?? "intact"}
            active={game.activeWire === color}
            minimal={minimal}
          />
        );
      })}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* One wire                                                                   */
/* -------------------------------------------------------------------------- */

function WireRow({
  color,
  row,
  y,
  status,
  active,
  minimal,
}: {
  color: string;
  row: number;
  y: number;
  status: string;
  active: boolean;
  minimal: boolean;
}) {
  const hex = WIRE_HEX[color];
  const cut = status === "cut";
  const deferred = status === "deferred";

  const xEnd = PANEL_W / 2 - 0.3;
  const xStart = -PANEL_W / 2 + 0.42;
  /**
   * The break sits at the wire's own midpoint, not at the panel's.
   *
   * The two ends are not symmetric — the left post is inset further to clear the
   * number plate — so x=0 is off-centre on the cable by about half a plate's
   * width. Small, but the break is the one place a viewer looks closely.
   */
  const xMid = (xStart + xEnd) / 2;

  /**
   * Animation clock in a ref, not state.
   *
   * A cut is a sub-second sequence sampled every frame. Driving that through
   * React state would re-render the entire scene sixty times a second for one
   * wire's worth of motion.
   */
  const progress = useRef(cut ? 1 : 0);
  const wholeRef = useRef<THREE.Mesh>(null);
  const leftRef = useRef<THREE.Group>(null);
  const rightRef = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.PointLight>(null);
  const sparksRef = useRef<THREE.Points>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  /**
   * Wires sag. A dead-straight cable across a board looks like a diagram, and a
   * shallow catenary with a little side-to-side waver looks like something
   * somebody screwed to a wall — which is the whole illusion.
   */
  const makeCurve = (
    from: number,
    to: number,
    opts: {
      sagScale?: number;
      /** How far the severed end hangs below the line. 0 for an intact wire. */
      hang?: number;
      /** Which end is the severed one. The other stays bolted to its post. */
      hangAt?: "from" | "to";
    } = {},
  ) => {
    const { sagScale = 1, hang = 0, hangAt = "to" } = opts;
    const points: THREE.Vector3[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from + (to - from) * t;
      /**
       * Squared, and squared from the ANCHORED end, so the curve leaves the post
       * horizontally and all the droop accumulates at the free end. A linear
       * droop pulls the wire off its terminal, which reads as a modelling
       * mistake rather than as a cut cable.
       */
      const k = hangAt === "from" ? (1 - t) * (1 - t) : t * t;
      const sag = Math.sin(t * Math.PI) * 0.035 * sagScale;
      const waver = Math.sin(t * Math.PI * 2 + row) * 0.012;
      points.push(new THREE.Vector3(x, hang * k - sag + waver, 0.055));
    }
    return new THREE.CatmullRomCurve3(points);
  };

  const wholeCurve = useMemo(
    () => makeCurve(xStart, xEnd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row],
  );
  const leftCurve = useMemo(
    () =>
      makeCurve(xStart, xMid - CUT_GAP, {
        sagScale: 0.5,
        hang: -CUT_HANG,
        hangAt: "to",
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row],
  );
  const rightCurve = useMemo(
    () =>
      makeCurve(xMid + CUT_GAP, xEnd, {
        sagScale: 0.5,
        hang: -CUT_HANG,
        hangAt: "from",
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row],
  );

  /**
   * Where the copper is exposed — read off the curve rather than guessed, so it
   * stays welded to the end of the tube if the gap or the droop is ever retuned.
   */
  const leftEnd = useMemo(() => leftCurve.getPoint(1), [leftCurve]);
  const rightEnd = useMemo(() => rightCurve.getPoint(0), [rightCurve]);

  /** A cut wire is dead. Same hue, drained, so "cut" reads even in a still. */
  const deadHex = useMemo(() => new THREE.Color(hex).multiplyScalar(0.42), [hex]);

  const sparkGeometry = useMemo(() => {
    if (minimal) return null;
    const count = 30;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 0.5 + Math.random() * 1.5;
      velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      // Biased upward — sparks fly off a snip, they do not rain down.
      velocities[i * 3 + 1] = Math.abs(Math.cos(phi)) * speed * 1.25;
      velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed * 0.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("velocity", new THREE.BufferAttribute(velocities, 3));
    return geo;
  }, [minimal]);

  useFrame((state, delta) => {
    const t0 = state.clock.elapsedTime;
    const target = cut ? 1 : 0;
    progress.current += (target - progress.current) * Math.min(1, delta * 6);
    const t = progress.current;

    if (wholeRef.current) wholeRef.current.visible = t < 0.32;
    if (leftRef.current) leftRef.current.visible = t >= 0.32;
    if (rightRef.current) rightRef.current.visible = t >= 0.32;

    // Flash hot for the first moments of the cut, then gone.
    if (flashRef.current) {
      flashRef.current.intensity = cut && t < 0.6 ? Math.sin(t * Math.PI * 1.7) * 3.2 : 0;
    }

    /**
     * The severed ends recoil apart. Translation only — the droop is baked into
     * the curves, because rotating these groups pivots them about the panel's
     * centre and swings the far, still-bolted end off its terminal post.
     */
    const recoil = THREE.MathUtils.smoothstep(t, 0.32, 1);
    if (leftRef.current) leftRef.current.position.x = -recoil * 0.05;
    if (rightRef.current) rightRef.current.position.x = recoil * 0.05;

    // The active wire breathes, so the room knows which one is in play.
    if (glowRef.current) {
      const mat = glowRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = active && !cut ? 0.2 + Math.sin(t0 * 3) * 0.09 : 0;
    }

    if (sparksRef.current && sparkGeometry) {
      const visible = cut && t > 0.28 && t < 0.95;
      sparksRef.current.visible = visible;
      if (visible) {
        const pos = sparkGeometry.attributes.position as THREE.BufferAttribute;
        const vel = sparkGeometry.attributes.velocity as THREE.BufferAttribute;
        const age = (t - 0.28) / 0.67;
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(
            i,
            vel.getX(i) * age * 0.11,
            vel.getY(i) * age * 0.11 - age * age * 0.18,
            vel.getZ(i) * age * 0.11,
          );
        }
        pos.needsUpdate = true;
        (sparksRef.current.material as THREE.PointsMaterial).opacity = 1 - age;
      }
    }
  });

  const emissive = active && !cut ? 0.5 : deferred ? 0.02 : 0.1;

  return (
    <group position={[0, y, 0]}>
      <RowNumber index={row} x={-PANEL_W / 2 + 0.16} />

      {/* Terminal posts at both ends. Brushed steel, screwed to the board. */}
      {[xStart, xEnd].map((x) => (
        <group key={x} position={[x, 0, 0.055]}>
          {/* Mounting plate */}
          <mesh position={[0, 0, -0.02]}>
            <boxGeometry args={[0.13, 0.13, 0.02]} />
            <meshStandardMaterial color="#8e8b84" roughness={0.42} metalness={0.85} />
          </mesh>
          {/* Post */}
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.022, 0.022, 0.1, 10]} />
            <meshStandardMaterial color="#a8a49c" roughness={0.3} metalness={0.95} />
          </mesh>
        </group>
      ))}

      <mesh ref={wholeRef}>
        <tubeGeometry args={[wholeCurve, 46, 0.019, 8, false]} />
        <meshStandardMaterial
          color={hex}
          emissive={hex}
          emissiveIntensity={emissive}
          roughness={0.42}
          transparent
          opacity={deferred ? 0.4 : 1}
        />
      </mesh>

      <group ref={leftRef} visible={false}>
        <mesh>
          <tubeGeometry args={[leftCurve, 30, 0.019, 8, false]} />
          <meshStandardMaterial color={deadHex} roughness={0.7} />
        </mesh>
        {/* Exposed copper at the cut, welded to the end of the tube. */}
        <mesh position={[leftEnd.x, leftEnd.y, leftEnd.z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.013, 0.013, 0.04, 8]} />
          <meshStandardMaterial color="#c9873f" roughness={0.3} metalness={1} />
        </mesh>
      </group>

      <group ref={rightRef} visible={false}>
        <mesh>
          <tubeGeometry args={[rightCurve, 30, 0.019, 8, false]} />
          <meshStandardMaterial color={deadHex} roughness={0.7} />
        </mesh>
        <mesh position={[rightEnd.x, rightEnd.y, rightEnd.z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.013, 0.013, 0.04, 8]} />
          <meshStandardMaterial color="#c9873f" roughness={0.3} metalness={1} />
        </mesh>
      </group>

      {/* Soft halo behind the active wire. */}
      <mesh ref={glowRef} position={[xMid, 0, 0.045]}>
        <planeGeometry args={[PANEL_W - 0.5, 0.16]} />
        <meshBasicMaterial color={hex} transparent opacity={0} toneMapped={false} />
      </mesh>

      <pointLight ref={flashRef} position={[xMid, 0, 0.3]} color="#fffdf0" intensity={0} distance={2} />

      {sparkGeometry && (
        <points ref={sparksRef} geometry={sparkGeometry} position={[xMid, 0, 0.07]} visible={false}>
          <pointsMaterial
            color="#ffd98a"
            size={0.03}
            transparent
            opacity={1}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      )}
    </group>
  );
}

/**
 * The 1–5 labels down the left edge, as engraved metal plates.
 *
 * Canvas textures rather than 3D text: drei/troika fetches a font file at
 * runtime, and a projector on venue wifi is exactly where that fails and leaves
 * five blank squares.
 */
function RowNumber({ index, x }: { index: number; x: number }) {
  const texture = useMemo(
    () =>
      createCanvasTexture(64, 64, (ctx) => {
        // An engraved metal plate: pale brushed background, dark digit.
        ctx.fillStyle = "#b8b4ab";
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#2a2822";
        ctx.font = "700 44px 'Barlow Condensed', 'Arial Narrow', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(index + 1), 32, 34);
      }).texture,
    [index],
  );

  return (
    <mesh position={[x, 0, 0.055]}>
      <planeGeometry args={[0.13, 0.13]} />
      <meshStandardMaterial map={texture} roughness={0.5} metalness={0.4} />
    </mesh>
  );
}

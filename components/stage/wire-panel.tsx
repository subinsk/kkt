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
 * terminating in a metal post at either end. Some carry an inline barrel
 * connector, which is pure set dressing and does a lot of work: it makes the
 * board read as a real piece of prop hardware rather than five coloured lines.
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
  const makeCurve = (from: number, to: number, sagScale = 1) => {
    const points: THREE.Vector3[] = [];
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from + (to - from) * t;
      const sag = Math.sin(t * Math.PI) * 0.035 * sagScale;
      const waver = Math.sin(t * Math.PI * 2 + row) * 0.012;
      points.push(new THREE.Vector3(x, -sag + waver, 0.055));
    }
    return new THREE.CatmullRomCurve3(points);
  };

  const wholeCurve = useMemo(
    () => makeCurve(xStart, xEnd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row],
  );
  // A small gap at the break, so the two stubs never visually touch.
  const leftCurve = useMemo(
    () => makeCurve(xStart, -0.06, 0.55),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row],
  );
  const rightCurve = useMemo(
    () => makeCurve(0.06, xEnd, 0.55),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row],
  );

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

    // The severed ends recoil apart, then sag.
    const recoil = THREE.MathUtils.smoothstep(t, 0.32, 1);
    if (leftRef.current) {
      leftRef.current.position.x = -recoil * 0.06;
      leftRef.current.rotation.z = recoil * 0.1;
      leftRef.current.position.y = -recoil * 0.035;
    }
    if (rightRef.current) {
      rightRef.current.position.x = recoil * 0.06;
      rightRef.current.rotation.z = -recoil * 0.1;
      rightRef.current.position.y = -recoil * 0.035;
    }

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

      {/* Inline barrel connector — set dressing that sells it as hardware. */}
      {!cut && (row === 1 || row === 3) && (
        <mesh position={[0.12, -0.03, 0.055]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.032, 0.032, 0.19, 10]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.55} metalness={0.5} />
        </mesh>
      )}
      {!cut && row === 4 && (
        <mesh position={[0.0, -0.035, 0.055]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 0.17, 10]} />
          <meshStandardMaterial color="#9a7742" roughness={0.35} metalness={0.9} />
        </mesh>
      )}

      <group ref={leftRef} visible={false}>
        <mesh>
          <tubeGeometry args={[leftCurve, 26, 0.019, 8, false]} />
          <meshStandardMaterial color={hex} roughness={0.55} emissive={hex} emissiveIntensity={0.03} />
        </mesh>
        {/* Exposed copper at the cut. */}
        <mesh position={[-0.05, -0.02, 0.055]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.03, 8]} />
          <meshStandardMaterial color="#c9873f" roughness={0.3} metalness={1} />
        </mesh>
      </group>

      <group ref={rightRef} visible={false}>
        <mesh>
          <tubeGeometry args={[rightCurve, 26, 0.019, 8, false]} />
          <meshStandardMaterial color={hex} roughness={0.55} emissive={hex} emissiveIntensity={0.03} />
        </mesh>
        <mesh position={[0.05, -0.02, 0.055]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.03, 8]} />
          <meshStandardMaterial color="#c9873f" roughness={0.3} metalness={1} />
        </mesh>
      </group>

      {/* Soft halo behind the active wire. */}
      <mesh ref={glowRef} position={[0, 0, 0.045]}>
        <planeGeometry args={[PANEL_W - 0.5, 0.16]} />
        <meshBasicMaterial color={hex} transparent opacity={0} toneMapped={false} />
      </mesh>

      <pointLight ref={flashRef} position={[0, 0, 0.3]} color="#fffdf0" intensity={0} distance={2} />

      {sparkGeometry && (
        <points ref={sparksRef} geometry={sparkGeometry} position={[0, 0, 0.07]} visible={false}>
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

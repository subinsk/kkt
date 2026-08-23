"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import { createCanvasTexture } from "./canvas-texture";

/**
 * The meeting room.
 *
 * A corporate boardroom, not a TV studio — which is what the fiction actually
 * calls for: a prank device planted in an office, in whichever room we happen to
 * be sitting in. The comedy and the safety both come from the setting being
 * mundane.
 *
 * Contents, working outward: wood-panelled back wall, painted side walls, grey
 * carpet, a ceiling with recessed lights, a window on the right throwing cool
 * daylight across the room, a flipchart, and a plant in the corner.
 */

export const ROOM = {
  width: 9.4,
  height: 3.1,
  depth: 9.5,
  /** Back wall, where the wire panel and the clock are mounted. */
  backZ: -3.2,
};

export function Room({ game }: { game: PublicGame }) {
  const panic = game.secondsLeft <= 60 && game.phase === "running";

  return (
    <group>
      <Carpet />
      <Ceiling />
      <BackWall />
      <SideWalls />
      <Window />
      <WallClock game={game} panic={panic} />
      <Flipchart />
      <Plant />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

function Carpet() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[ROOM.width, ROOM.depth * 1.6]} />
      {/* Dark grey office carpet: rough, almost no specular. */}
      <meshStandardMaterial color="#3a3936" roughness={0.96} metalness={0} />
    </mesh>
  );
}

function Ceiling() {
  return (
    <group>
      <mesh
        position={[0, ROOM.height, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[ROOM.width, ROOM.depth * 1.6]} />
        <meshStandardMaterial color="#e8e6e1" roughness={0.95} />
      </mesh>

      {/* Recessed panel lights. Emissive rectangles — the room's ambience is
          motivated by something visible, which reads better than a bare light. */}
      {[-2.2, 0.6].map((z) =>
        [-2.4, 0, 2.4].map((x) => (
          <mesh key={`${x}-${z}`} position={[x, ROOM.height - 0.015, z]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.1, 0.3]} />
            <meshBasicMaterial color="#fffaf0" toneMapped={false} />
          </mesh>
        )),
      )}
    </group>
  );
}

/**
 * The back wall: vertical wood panelling.
 *
 * Built as individual boards with slightly varied tone rather than one textured
 * plane. It costs a couple of dozen boxes and it is the single biggest reason
 * the room looks built instead of rendered — the seams catch light unevenly.
 */
function BackWall() {
  const boards = 16;
  const boardWidth = ROOM.width / boards;

  const tones = useMemo(
    () =>
      Array.from({ length: boards }, (_, i) => {
        // Deterministic variation — Math.random() here would reshuffle the
        // grain on every hot reload, which is maddening to look at.
        const n = Math.sin(i * 12.9898) * 43758.5453;
        const jitter = (n - Math.floor(n)) * 0.14 - 0.07;
        return new THREE.Color("#8a6a48").offsetHSL(0, 0, jitter);
      }),
    [boards],
  );

  return (
    <group position={[0, 0, ROOM.backZ]}>
      {/* Plaster above the panelling. */}
      <mesh position={[0, ROOM.height - 0.35, -0.06]}>
        <planeGeometry args={[ROOM.width, 0.7]} />
        <meshStandardMaterial color="#ddd8d0" roughness={0.95} />
      </mesh>

      {Array.from({ length: boards }).map((_, i) => (
        <mesh
          key={i}
          position={[-ROOM.width / 2 + boardWidth * (i + 0.5), 1.35, 0]}
          receiveShadow
        >
          <boxGeometry args={[boardWidth - 0.012, 2.7, 0.06]} />
          <meshStandardMaterial
            color={tones[i]}
            roughness={0.62}
            metalness={0.06}
          />
        </mesh>
      ))}

      {/* Skirting */}
      <mesh position={[0, 0.05, 0.04]}>
        <boxGeometry args={[ROOM.width, 0.1, 0.03]} />
        <meshStandardMaterial color="#2a2724" roughness={0.8} />
      </mesh>
    </group>
  );
}

function SideWalls() {
  return (
    <group>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[(side * ROOM.width) / 2, ROOM.height / 2, 0]}
          rotation={[0, -side * (Math.PI / 2), 0]}
          receiveShadow
        >
          <planeGeometry args={[ROOM.depth * 1.6, ROOM.height]} />
          <meshStandardMaterial color="#dedad2" roughness={0.94} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Window on the right wall.
 *
 * Its job is the cool daylight it motivates: without a visible source, the blue
 * fill on the right-hand side of the room looks like a mistake.
 */
function Window() {
  const x = ROOM.width / 2 - 0.04;
  return (
    <group position={[x, 1.85, -1.1]} rotation={[0, -Math.PI / 2, 0]}>
      {/* Blown-out daylight. */}
      <mesh>
        <planeGeometry args={[2.6, 1.5]} />
        <meshBasicMaterial color="#eaf4ff" toneMapped={false} />
      </mesh>
      {/* Frame + mullion */}
      <mesh position={[0, 0, 0.03]}>
        <boxGeometry args={[2.72, 1.62, 0.05]} />
        <meshStandardMaterial color="#c9c5be" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0, 0.05]}>
        <boxGeometry args={[2.56, 1.46, 0.02]} />
        <meshBasicMaterial color="#eaf4ff" toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.1, 0.06]}>
        <boxGeometry args={[2.56, 0.04, 0.03]} />
        <meshStandardMaterial color="#c9c5be" roughness={0.6} metalness={0.3} />
      </mesh>
      {/* Sill */}
      <mesh position={[0, -0.84, -0.12]}>
        <boxGeometry args={[2.8, 0.06, 0.3]} />
        <meshStandardMaterial color="#dedad2" roughness={0.9} />
      </mesh>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* The clock                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Wall-mounted digital clock — the diegetic countdown.
 *
 * Drawn to a canvas because it is a seven-segment display: hard-edged, emissive,
 * legible from the back of a room. Redrawn only when the displayed second
 * changes rather than every frame.
 *
 * Note there are deliberately *two* clocks in this build: this one, which is
 * part of the room and part of the fiction, and the DOM one in the broadcast
 * overlay. Real television does exactly this — the scoreboard on the wall and
 * the graphic over the top — and having both means the overlay can be crisp
 * without the room looking empty.
 */
function WallClock({ game, panic }: { game: PublicGame; panic: boolean }) {
  const lastDrawn = useRef("");

  const { canvas, texture } = useMemo(
    () => createCanvasTexture(640, 160),
    [],
  );

  useFrame(() => {
    const secs = Math.max(0, game.secondsLeft);
    // Rendered as 00:MM:SS, like the reference — an office wall clock, not a
    // stopwatch.
    const text = `00:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(
      secs % 60,
    ).padStart(2, "0")}`;
    const key = `${text}|${game.phase}`;
    if (key === lastDrawn.current) return;
    lastDrawn.current = key;

    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;

    ctx.fillStyle = "#0a0a0c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const color =
      game.phase === "won" ? "#39ff88" : panic ? "#ff2a2a" : "#ff3b30";

    ctx.font = "700 112px 'Barlow Condensed', 'Arial Narrow', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);

    // Segment gaps, so it reads as LED rather than as a font.
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    for (let y = 0; y < canvas.height; y += 5) ctx.fillRect(0, y, canvas.width, 2);

    texture.needsUpdate = true;
  });

  return (
    <group position={[3.0, 2.42, ROOM.backZ + 0.09]}>
      {/* Housing */}
      <mesh>
        <boxGeometry args={[1.28, 0.36, 0.09]} />
        <meshStandardMaterial color="#111111" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* Display */}
      <mesh position={[0, 0, 0.048]}>
        <planeGeometry args={[1.14, 0.26]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {/* The glow it throws onto the wall. */}
      <pointLight
        position={[0, 0, 0.4]}
        color={panic ? "#ff3020" : "#ff5533"}
        intensity={panic ? 1.4 : 0.5}
        distance={2.4}
      />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Dressing                                                                   */
/* -------------------------------------------------------------------------- */

/** Flipchart on an easel. Blank — it is scenery, not a second screen. */
function Flipchart() {
  return (
    <group position={[-3.35, 0, -2.45]} rotation={[0, 0.34, 0]}>
      {/* Paper */}
      <mesh position={[0, 1.42, 0.02]} castShadow>
        <boxGeometry args={[0.94, 1.16, 0.02]} />
        <meshStandardMaterial color="#f6f4ef" roughness={0.92} />
      </mesh>
      {/* Board behind it */}
      <mesh position={[0, 1.42, 0]}>
        <boxGeometry args={[1.02, 1.24, 0.03]} />
        <meshStandardMaterial color="#1e1e1e" roughness={0.6} metalness={0.3} />
      </mesh>
      {/* Tripod legs */}
      {[-0.38, 0.38].map((x) => (
        <mesh key={x} position={[x, 0.4, 0.06]} rotation={[0.1, 0, x > 0 ? -0.07 : 0.07]}>
          <cylinderGeometry args={[0.016, 0.016, 0.82, 6]} />
          <meshStandardMaterial color="#232323" roughness={0.5} metalness={0.5} />
        </mesh>
      ))}
      <mesh position={[0, 0.4, -0.16]} rotation={[-0.16, 0, 0]}>
        <cylinderGeometry args={[0.016, 0.016, 0.84, 6]} />
        <meshStandardMaterial color="#232323" roughness={0.5} metalness={0.5} />
      </mesh>
    </group>
  );
}

/** The corner plant. Every meeting room has one, and its absence is noticeable. */
function Plant() {
  const leaves = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => {
        const n = Math.sin(i * 78.233) * 43758.5453;
        const r = n - Math.floor(n);
        return {
          angle: (i / 14) * Math.PI * 2 + r,
          tilt: 0.5 + r * 0.7,
          length: 0.3 + r * 0.26,
          height: 0.46 + r * 0.34,
        };
      }),
    [],
  );

  return (
    <group position={[-4.15, 0, -2.5]}>
      {/* Pot */}
      <mesh position={[0, 0.24, 0]} castShadow>
        <cylinderGeometry args={[0.21, 0.16, 0.48, 16]} />
        <meshStandardMaterial color="#d8d4cd" roughness={0.85} />
      </mesh>
      {/* Soil */}
      <mesh position={[0, 0.47, 0]}>
        <cylinderGeometry args={[0.19, 0.19, 0.03, 16]} />
        <meshStandardMaterial color="#2a211a" roughness={1} />
      </mesh>

      {leaves.map((leaf, i) => (
        <mesh
          key={i}
          position={[
            Math.cos(leaf.angle) * 0.09,
            leaf.height,
            Math.sin(leaf.angle) * 0.09,
          ]}
          rotation={[leaf.tilt, leaf.angle, 0]}
          castShadow
        >
          {/* Flat blades, double-sided — cheap and reads correctly as foliage. */}
          <planeGeometry args={[0.14, leaf.length]} />
          <meshStandardMaterial
            color={i % 3 === 0 ? "#2f6b32" : "#37803a"}
            roughness={0.75}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

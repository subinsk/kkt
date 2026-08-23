"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import { TaskChair } from "./furniture";

/**
 * The three contestants, seen from behind.
 *
 * The camera sits behind them, so what the audience sees is the backs of heads
 * and shoulders in the near foreground. That framing is the best thing about
 * this staging: the audience is placed *in the contestants' seats*, so the
 * projector view is a first-person view of the game rather than a diorama of it.
 *
 * It also changes where the detail goes. Nobody ever sees these faces, so there
 * are none — the modelling budget goes into hair silhouette, shoulder shape, and
 * the chairs.
 *
 * Each seat lights up when its occupant is live to the host, which is what makes
 * Peer Talk visible to the room. The most interesting thing happening in this
 * system is *who the host can currently hear*, and an audience watching a
 * projector has no other way to know it.
 */

/** Near side of the table, in a shallow arc. Seat 1 is stage-left. */
export const SEAT_POSITIONS: [number, number, number][] = [
  [-1.42, 0, 1.26],
  [0, 0, 1.52],
  [1.42, 0, 1.26],
  [2.5, 0, 0.42],
];

const SEAT_Y = 0.42;

export function Contestants({ game }: { game: PublicGame }) {
  return (
    <group>
      {game.players.map((player, i) => (
        <Contestant
          key={player.id}
          position={SEAT_POSITIONS[i] ?? SEAT_POSITIONS[0]}
          color={player.color}
          seat={i}
          live={game.live.includes(player.id)}
          speaking={game.lastSpeaker === player.id}
          connected={player.connected}
        />
      ))}

      {/* Empty chairs, so three seats read as three seats before anyone joins. */}
      {Array.from({ length: Math.max(0, 3 - game.players.length) }).map((_, i) => {
        const pos = SEAT_POSITIONS[game.players.length + i] ?? SEAT_POSITIONS[2];
        return (
          <TaskChair
            key={`empty-${i}`}
            position={[pos[0], 0, pos[2] + 0.42]}
            rotation={Math.PI}
          />
        );
      })}
    </group>
  );
}

function Contestant({
  position,
  color,
  seat,
  live,
  speaking,
  connected,
}: {
  position: [number, number, number];
  color: string;
  seat: number;
  live: boolean;
  speaking: boolean;
  connected: boolean;
}) {
  const body = useRef<THREE.Group>(null);
  const rim = useRef<THREE.PointLight>(null);
  const halo = useRef<THREE.Mesh>(null);
  const heat = useRef(0);

  /**
   * Face the host. The seats are in an arc, so the outer two turn inward — which
   * is both correct and the thing that makes the group read as a conversation
   * rather than a row.
   */
  const facing = useMemo(
    () => Math.atan2(0 - position[0], -1.62 - position[2]) + Math.PI,
    [position],
  );

  /** Deterministic per-seat variation, so the three are not clones. */
  const variant = useMemo(() => {
    const n = Math.sin((seat + 1) * 91.7) * 43758.5453;
    const r = n - Math.floor(n);
    return {
      longHair: seat === 0,
      shoulderWidth: 0.27 + r * 0.05,
      suit: ["#1c1c24", "#22222c", "#2c2c34"][seat % 3],
      hair: ["#120f0d", "#171310", "#0e0c0b"][seat % 3],
    };
  }, [seat]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;

    // One value drives the whole seat: cold in discussion, hot when live,
    // hottest when they are the attributed speaker.
    const target = speaking ? 1 : live ? 0.6 : 0.05;
    heat.current = THREE.MathUtils.lerp(heat.current, target, delta * 5);

    if (rim.current) rim.current.intensity = heat.current * 2.6;

    if (halo.current) {
      const mat = halo.current.material as THREE.MeshBasicMaterial;
      mat.opacity = heat.current * 0.55;
      halo.current.scale.setScalar(live ? 1 + Math.sin(t * 3.4) * 0.04 : 1);
    }

    if (body.current) {
      // Live contestants sit up and lean in slightly. Idle ones slouch and sway.
      body.current.position.y = SEAT_Y + heat.current * 0.018 + Math.sin(t * 0.7 + seat) * 0.005;
      body.current.rotation.x = -heat.current * 0.05;
      body.current.rotation.z = Math.sin(t * 0.5 + seat * 2) * 0.009;
    }
  });

  return (
    <group position={[position[0], 0, position[2]]} rotation={[0, facing, 0]}>
      {/* Their chair, behind them from the host's point of view. */}
      <TaskChair position={[0, 0, -0.42]} rotation={0} />

      <group ref={body} position={[0, SEAT_Y, 0]}>
        {/* Torso */}
        <mesh position={[0, 0.38, 0]} castShadow>
          <cylinderGeometry args={[0.28, 0.21, 0.68, 8]} />
          <meshStandardMaterial color={variant.suit} roughness={0.78} />
        </mesh>

        {/* Shoulders */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * variant.shoulderWidth, 0.64, 0]}
            castShadow
          >
            <sphereGeometry args={[0.1, 10, 8]} />
            <meshStandardMaterial color={variant.suit} roughness={0.78} />
          </mesh>
        ))}

        {/**
         * Seat-colour band across the shoulders.
         *
         * On the BACK, not the chest — the back is the only part of them the
         * audience can see. Without this, a live contestant would be identifiable
         * only by their floor halo.
         */}
        <mesh position={[0, 0.56, -0.19]}>
          <boxGeometry args={[0.4, 0.07, 0.03]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={live ? 1.5 : 0.35}
            toneMapped={false}
          />
        </mesh>

        {/* Arms forward onto the table. */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * 0.24, 0.36, 0.16]}
            rotation={[1.1, 0, side * 0.2]}
            castShadow
          >
            <cylinderGeometry args={[0.052, 0.05, 0.4, 7]} />
            <meshStandardMaterial color={variant.suit} roughness={0.78} />
          </mesh>
        ))}

        {/* Neck */}
        <mesh position={[0, 0.74, -0.01]}>
          <cylinderGeometry args={[0.048, 0.055, 0.09, 8]} />
          <meshStandardMaterial
            color={connected ? "#9a7050" : "#5a4a3c"}
            roughness={0.66}
          />
        </mesh>

        {/* Head — we see the back of it, so it is almost entirely hair. */}
        <mesh position={[0, 0.88, -0.01]} castShadow>
          <sphereGeometry args={[0.128, 14, 12]} />
          <meshStandardMaterial color={variant.hair} roughness={0.88} />
        </mesh>

        {/* A sliver of skin at the nape, which stops the head reading as a ball
            of felt. */}
        <mesh position={[0, 0.79, 0.02]}>
          <sphereGeometry args={[0.09, 10, 8]} />
          <meshStandardMaterial
            color={connected ? "#9a7050" : "#5a4a3c"}
            roughness={0.66}
          />
        </mesh>

        {/* Long hair down the back for one seat, per the reference. It is the
            clearest way to make the three silhouettes distinguishable. */}
        {variant.longHair && (
          <>
            <mesh position={[0, 0.66, -0.11]} castShadow>
              <boxGeometry args={[0.24, 0.42, 0.09]} />
              <meshStandardMaterial color={variant.hair} roughness={0.9} />
            </mesh>
            <mesh position={[0, 0.45, -0.12]} castShadow>
              <boxGeometry args={[0.18, 0.2, 0.07]} />
              <meshStandardMaterial color={variant.hair} roughness={0.9} />
            </mesh>
          </>
        )}
      </group>

      {/* Floor halo — how a seat announces it is live from the back of a room. */}
      <mesh ref={halo} position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.34, 0.5, 32]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/* Rim from behind, so a live contestant is edge-lit in their own colour. */}
      <pointLight
        ref={rim}
        position={[0, 1.05, -0.45]}
        color={color}
        intensity={0}
        distance={1.9}
      />
    </group>
  );
}

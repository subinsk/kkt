"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import { CHAIR_SET_BACK, TABLE_SURFACE, TaskChair, seatAt } from "./furniture";
import { HOST_POSITION } from "./host";
import { Limb } from "./limb";

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

/**
 * Near side of the table, in a shallow arc. Seat 1 is stage-left.
 *
 * Placed by angle around the table rather than by hand, so a body is always
 * outside the tabletop. The previous hardcoded coordinates put all three
 * *inside* the outer ellipse, which meant the slab passed straight through their
 * chests — see `seatAt`.
 */
export const SEAT_POSITIONS: [number, number, number][] = [
  seatAt(126),
  seatAt(90),
  seatAt(54),
  seatAt(18),
];

const SEAT_Y = 0.42;

/** Table height in a seated contestant's own coordinates. */
const REST_Y = TABLE_SURFACE - SEAT_Y;

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

      {/**
       * Empty chairs, so three seats read as three seats before anyone joins.
       *
       * Placed exactly the way an occupied seat is — rotated to face the host,
       * then set back along its own local −Z. The previous version offset by
       * +0.42 in world Z and turned a flat half-circle, which is only correct
       * for the seat dead centre; the two on the arc ended up beside their own
       * place setting, facing off at an angle.
       */}
      {Array.from({ length: Math.max(0, 3 - game.players.length) }).map((_, i) => {
        const pos = SEAT_POSITIONS[game.players.length + i] ?? SEAT_POSITIONS[2];
        const facing = Math.atan2(
          HOST_POSITION[0] - pos[0],
          HOST_POSITION[2] - pos[2],
        );
        return (
          <group
            key={`empty-${i}`}
            position={[pos[0], 0, pos[2]]}
            rotation={[0, facing, 0]}
          >
            <TaskChair position={[0, 0, -CHAIR_SET_BACK]} />
          </group>
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
   *
   * There is deliberately no `+ Math.PI` here. With it, every contestant was
   * turned a half-turn away from the host: arms reached out toward the camera
   * instead of onto the table, the long hair and the live-seat band ended up on
   * the side only the host could see, and the nape of the neck faced front.
   * Local +Z is toward the host; local −Z is the back, which the camera sees.
   */
  const facing = useMemo(
    () =>
      Math.atan2(
        HOST_POSITION[0] - position[0],
        HOST_POSITION[2] - position[2],
      ),
    [position],
  );

  /** Deterministic per-seat variation, so the three are not clones. */
  const variant = useMemo(() => {
    const n = Math.sin((seat + 1) * 91.7) * 43758.5453;
    const r = n - Math.floor(n);
    return {
      longHair: seat === 0,
      shoulderWidth: 0.27 + r * 0.05,
      /**
       * A different t-shirt each, because three people pulled out of an office
       * are not a uniformed panel — and from behind, the shirt is most of what
       * distinguishes one silhouette from the next.
       *
       * Muted on purpose. These have to lose to the emissive seat band on the
       * back, which is the only thing telling the room who the host can hear;
       * a saturated shirt in the same frame would compete with it.
       */
      shirt: ["#3c4a68", "#4a5539", "#68403c", "#453a5c"][seat % 4],
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
      <TaskChair position={[0, 0, -CHAIR_SET_BACK]} rotation={0} />

      <group ref={body} position={[0, SEAT_Y, 0]}>
        {/* Torso */}
        <mesh position={[0, 0.38, 0]} castShadow>
          <cylinderGeometry args={[0.28, 0.21, 0.68, 8]} />
          <meshStandardMaterial color={variant.shirt} roughness={0.78} />
        </mesh>

        {/* Shoulders */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * variant.shoulderWidth, 0.64, 0]}
            castShadow
          >
            <sphereGeometry args={[0.1, 10, 8]} />
            <meshStandardMaterial color={variant.shirt} roughness={0.78} />
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

        {/**
         * Arms, built joint to joint rather than from tuned rotations.
         *
         * Shoulder sits inside the shoulder sphere, elbow overhangs the table's
         * near edge, wrist and hand rest on the surface at `REST_Y`. `Limb`
         * derives each segment from its two ends, so no joint can come apart the
         * way the previous hand-rotated cylinders did.
         */}
        {[-1, 1].map((side) => {
          const shoulder: [number, number, number] = [side * 0.26, 0.62, 0.02];
          const elbow: [number, number, number] = [side * 0.28, 0.47, 0.24];
          const wrist: [number, number, number] = [
            side * 0.15,
            REST_Y + 0.05,
            0.52,
          ];
          const skin = connected ? "#9a7050" : "#5a4a3c";
          return (
            <group key={side}>
              <Limb
                from={shoulder}
                to={elbow}
                radius={0.058}
                tipRadius={0.05}
                color={variant.shirt}
                roughness={0.78}
              />
              <Limb
                from={elbow}
                to={wrist}
                radius={0.05}
                tipRadius={0.045}
                color={variant.shirt}
                roughness={0.78}
              />
              {/* Hand, flat on the table. */}
              <mesh
                position={[side * 0.13, REST_Y + 0.05, 0.575]}
                scale={[1, 0.7, 1.15]}
                castShadow
              >
                <sphereGeometry args={[0.056, 10, 8]} />
                <meshStandardMaterial color={skin} roughness={0.66} />
              </mesh>
            </group>
          );
        })}

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
            of felt. On −Z: the nape is the back of the neck, and the back is the
            side facing the camera. */}
        <mesh position={[0, 0.79, -0.03]}>
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

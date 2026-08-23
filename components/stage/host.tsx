"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import { TABLE } from "./furniture";

/**
 * Amitabh bhai.
 *
 * Seated at the far side of the table, facing the camera — which means facing
 * the contestants, since the camera sits behind them. He is the only face in the
 * scene, so he carries all of it.
 *
 * Stylized and low-poly on purpose. We are not building a photoreal human, and
 * trying would land somewhere worse than a clean abstraction. What sells him is
 * not the mesh, it is the behaviour:
 *
 *   - head bob and a warm key swell driven by his actual audio level
 *   - turns to face whichever contestant is attributed as speaking
 *   - leans forward under a minute
 *   - idle sway when nobody is talking
 *
 * Hands clasped on the table, as in the reference. A seated figure with nothing
 * to do with its arms looks like a mannequin.
 *
 * Persona note: an original character. We parody the quiz-show format, never a
 * specific real presenter.
 */

/** Far side of the table, centred. Faces +Z, straight down the lens. */
export const HOST_POSITION: [number, number, number] = [0, 0, -1.62];

/** Seat height for everyone at this table. */
const SEAT_Y = 0.42;

export function Host({
  game,
  levelRef,
  seatPositions,
}: {
  game: PublicGame;
  /** Live audio level, 0..1, read every frame without re-rendering. */
  levelRef: React.RefObject<number>;
  seatPositions: [number, number, number][];
}) {
  const root = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const keyLight = useRef<THREE.PointLight>(null);

  /** Smoothed, so the figure breathes rather than twitches. */
  const speaking = useRef(0);
  const lean = useRef(0);
  const yaw = useRef(0);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const level = levelRef.current ?? 0;

    speaking.current = THREE.MathUtils.lerp(speaking.current, level, 0.22);
    const intensity = speaking.current;

    /* -- who is he looking at? ------------------------------------------ */

    // Facing +Z is straight at the contestants. A speaker off to one side
    // gets a turn of the head and shoulders toward them.
    let targetYaw = 0;
    const index = game.players.findIndex((p) => p.id === game.lastSpeaker);
    if (index >= 0 && seatPositions[index]) {
      const [sx, , sz] = seatPositions[index];
      targetYaw = Math.atan2(
        sx - HOST_POSITION[0],
        sz - HOST_POSITION[2],
      );
      targetYaw = THREE.MathUtils.clamp(targetYaw, -0.7, 0.7);
    }
    // Two people at once: he looks between them, which is exactly what a host
    // arbitrating a squabble does.
    if (game.contested) targetYaw = 0;

    yaw.current = THREE.MathUtils.lerp(yaw.current, targetYaw, delta * 3.2);
    if (torso.current) torso.current.rotation.y = yaw.current * 0.4;
    if (head.current) head.current.rotation.y = yaw.current * 0.6;

    /* -- posture -------------------------------------------------------- */

    const panic = game.secondsLeft <= 60 && game.phase === "running";
    const won = game.phase === "won";
    const targetLean = won ? -0.12 : panic ? 0.2 : 0.02;
    lean.current = THREE.MathUtils.lerp(lean.current, targetLean, delta * 2);

    if (root.current) {
      // Idle sway. Slow, small, never fully still.
      root.current.rotation.x = lean.current;
      root.current.rotation.z = Math.sin(t * 0.6) * 0.011 + Math.sin(t * 0.23) * 0.007;
      root.current.position.y = SEAT_Y + Math.sin(t * 0.9) * 0.005;
    }

    if (head.current) {
      // Head bob on the voice — the single most important line in this file.
      // Without it he is furniture; with it the room believes he is talking.
      head.current.position.y = 0.86 + intensity * 0.03 + Math.sin(t * 1.4) * 0.004;
      head.current.rotation.x = -intensity * 0.1 + Math.sin(t * 1.1) * 0.009;
    }

    if (keyLight.current) {
      keyLight.current.intensity = 1.0 + intensity * 2.4;
    }
  });

  return (
    <group ref={root} position={[HOST_POSITION[0], SEAT_Y, HOST_POSITION[2]]}>
      {/* Warm key on the host — the one bit of "presenter lighting" in an
          otherwise neutral office, and it swells when he speaks. */}
      <pointLight
        ref={keyLight}
        position={[0, 1.15, 0.85]}
        color="#ffc98a"
        intensity={1.0}
        distance={3.4}
      />

      <group ref={torso}>
        {/* Suit jacket. Tapered so the silhouette reads as shoulders. */}
        <mesh position={[0, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.29, 0.22, 0.72, 8]} />
          <meshStandardMaterial color="#16161c" roughness={0.74} metalness={0.08} />
        </mesh>

        {/* White shirt wedge — catches the key and separates him from the wall. */}
        <mesh position={[0, 0.5, 0.19]} rotation={[0.06, 0, 0]}>
          <boxGeometry args={[0.15, 0.38, 0.03]} />
          <meshStandardMaterial color="#f4f2ed" roughness={0.62} />
        </mesh>

        {/* Lapels */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * 0.1, 0.52, 0.185]}
            rotation={[0, 0, side * 0.22]}
          >
            <boxGeometry args={[0.09, 0.34, 0.025]} />
            <meshStandardMaterial color="#101016" roughness={0.66} />
          </mesh>
        ))}

        {/* Shoulders */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.27, 0.68, 0]} castShadow>
            <sphereGeometry args={[0.1, 10, 8]} />
            <meshStandardMaterial color="#16161c" roughness={0.74} />
          </mesh>
        ))}

        {/* Upper arms, angled in toward the clasped hands. */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * 0.26, 0.5, 0.08]}
            rotation={[0.5, 0, side * 0.2]}
            castShadow
          >
            <cylinderGeometry args={[0.058, 0.055, 0.34, 7]} />
            <meshStandardMaterial color="#16161c" roughness={0.74} />
          </mesh>
        ))}

        {/* Forearms resting on the table, converging. */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * 0.17, 0.33, 0.3]}
            rotation={[1.42, 0, side * 0.42]}
            castShadow
          >
            <cylinderGeometry args={[0.05, 0.048, 0.34, 7]} />
            <meshStandardMaterial color="#16161c" roughness={0.74} />
          </mesh>
        ))}

        {/* Cuffs */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.1, 0.32, 0.42]}>
            <cylinderGeometry args={[0.045, 0.045, 0.04, 8]} />
            <meshStandardMaterial color="#f4f2ed" roughness={0.6} />
          </mesh>
        ))}

        {/* Clasped hands, sitting just above the table surface. */}
        <mesh position={[0, 0.32, 0.47]} castShadow>
          <sphereGeometry args={[0.075, 10, 8]} />
          <meshStandardMaterial color="#9a7050" roughness={0.66} />
        </mesh>

        <group ref={head} position={[0, 0.86, 0.01]}>
          {/* Head. No painted face — at this fidelity a face is worse than
              none, and the audio-driven motion carries the character. */}
          <mesh castShadow>
            <sphereGeometry args={[0.135, 14, 12]} />
            <meshStandardMaterial color="#9a7050" roughness={0.64} />
          </mesh>

          {/* Hair, capping the top and back. */}
          <mesh position={[0, 0.03, -0.012]}>
            <sphereGeometry
              args={[0.139, 14, 12, 0, Math.PI * 2, 0, Math.PI / 1.75]}
            />
            <meshStandardMaterial color="#131010" roughness={0.88} />
          </mesh>

          {/* Trimmed beard along the jaw — the one silhouette cue that says
              "this specific host" without attempting a likeness. */}
          <mesh position={[0, -0.055, 0.035]} rotation={[0.34, 0, 0]}>
            <sphereGeometry
              args={[0.108, 12, 10, 0, Math.PI * 2, Math.PI / 2.2, Math.PI / 2.4]}
            />
            <meshStandardMaterial color="#1a1512" roughness={0.9} />
          </mesh>

          {/* Brows. Two small blocks, and they do a surprising amount to stop
              the head reading as a bare sphere. */}
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * 0.045, 0.028, 0.122]}>
              <boxGeometry args={[0.042, 0.011, 0.02]} />
              <meshStandardMaterial color="#171310" roughness={0.9} />
            </mesh>
          ))}
        </group>
      </group>

      {/* Chair back, just visible behind him. */}
      <mesh position={[0, 0.66, -0.34]} rotation={[-0.09, 0, 0]} castShadow>
        <boxGeometry args={[0.48, 0.58, 0.06]} />
        <meshStandardMaterial color="#17171a" roughness={0.82} />
      </mesh>
    </group>
  );
}

export { TABLE };

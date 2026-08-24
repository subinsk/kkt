"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import {
  CHAIR_SET_BACK,
  TABLE,
  TABLE_SURFACE,
  TaskChair,
  seatAt,
} from "./furniture";
import { Limb } from "./limb";

/**
 * Amitabh bhai.
 *
 * Seated at the far side of the table, facing the camera — which means facing
 * the contestants, since the camera sits behind them. He is the only face in the
 * scene, so he carries all of it.
 *
 * Stylized, not photoreal. The features are the recognisable ones of a veteran
 * quiz-show host — heavy dark specs, silver moustache and French-cut beard,
 * swept hair going grey at the sideburns, a cream shawl over a white shirt, a
 * lapel mic — assembled from primitives rather than sculpted. At projector
 * distance that reads better than a half-finished attempt at a real face would.
 *
 * What sells him is still the behaviour, not the mesh:
 *
 *   - head bob and a warm key swell driven by his actual audio level
 *   - turns to face whichever contestant is attributed as speaking
 *   - leans forward under a minute
 *   - idle sway when nobody is talking
 *
 * Hands clasped on the table. A seated figure with nothing to do with its arms
 * looks like a mannequin.
 */

/**
 * The host's palette.
 *
 * Cream and silver against a dark room, which is doing real work beyond taste:
 * he sits directly in front of the black wire panel, and a dark figure against a
 * dark board is a silhouette with no features at all. Light cloth is what lets
 * the face read from the back of a room.
 */
const SKIN = "#ad7f5c";
const SKIN_SHADE = "#8e6543";
const SHAWL = "#e2d7bf";
const SHIRT = "#f0ede5";
const HAIR = "#4a413a";
/** Moustache, beard and sideburns. Warm off-white, never pure. */
const SILVER = "#cfc9bd";
const FRAME = "#2b1a16";

/**
 * Far side of the table, centred, clear of the edge. Faces +Z, down the lens.
 *
 * Derived from the table rather than typed in, so he cannot end up sitting
 * inside the tabletop when the table's dimensions change.
 */
export const HOST_POSITION: [number, number, number] = seatAt(270);

/** Seat height for everyone at this table. */
const SEAT_Y = 0.42;

/**
 * Table height in the host's own coordinates — his group sits at `SEAT_Y`.
 *
 * Every forearm, cuff and hand below is placed against this. Hardcoding those
 * heights is how they ended up buried in the slab: the surface is 0.812 and the
 * arms were at 0.74.
 */
const REST_Y = TABLE_SURFACE - SEAT_Y;

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
        {/* White shirt. The body under everything else. */}
        <mesh position={[0, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.29, 0.22, 0.72, 12]} />
          <meshStandardMaterial color={SHIRT} roughness={0.72} />
        </mesh>

        {/* Open collar, standing either side of the throat. */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * 0.062, 0.7, 0.13]}
            rotation={[0.2, side * -0.5, side * 0.3]}
          >
            <boxGeometry args={[0.1, 0.09, 0.022]} />
            <meshStandardMaterial color={SHIRT} roughness={0.66} />
          </mesh>
        ))}

        {/**
         * The shawl, draped over both shoulders and falling down the front.
         *
         * A torus laid flat is a better drape than any arrangement of boxes: the
         * round section catches the key light along its top edge the way folded
         * cloth does, and it reads as one continuous piece behind the neck
         * rather than two panels meeting at a seam.
         */}
        <mesh position={[0, 0.63, 0.01]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[0.2, 0.062, 10, 24]} />
          <meshStandardMaterial color={SHAWL} roughness={0.92} />
        </mesh>

        {/* The two falling ends. */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[side * 0.155, 0.44, 0.13]}
            rotation={[0.12, 0, side * 0.07]}
            castShadow
          >
            <cylinderGeometry args={[0.08, 0.058, 0.44, 8]} />
            <meshStandardMaterial color={SHAWL} roughness={0.92} />
          </mesh>
        ))}

        {/* Shoulders, under the shawl. */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.27, 0.68, 0]} castShadow>
            <sphereGeometry args={[0.1, 12, 9]} />
            <meshStandardMaterial color={SHAWL} roughness={0.9} />
          </mesh>
        ))}

        {/* Lapel mic, where a lapel mic actually goes. Small, but it is the prop
            that says "broadcast" rather than "a man at a table". */}
        <mesh position={[0.085, 0.47, 0.2]}>
          <boxGeometry args={[0.024, 0.032, 0.016]} />
          <meshStandardMaterial color="#0c0c0c" roughness={0.5} />
        </mesh>
        <mesh position={[0.085, 0.38, 0.196]} rotation={[0, 0, 0.06]}>
          <cylinderGeometry args={[0.0035, 0.0035, 0.16, 6]} />
          <meshStandardMaterial color="#0c0c0c" roughness={0.6} />
        </mesh>

        {/**
         * Arms, built joint to joint: shoulder inside the shoulder sphere, elbow
         * just past the table's edge, wrist down on the surface.
         *
         * Elbow y sits above `REST_Y` on purpose — it overhangs the edge rather
         * than resting on it, which is what an elbow does.
         */}
        {[-1, 1].map((side) => {
          const shoulder: [number, number, number] = [side * 0.26, 0.66, 0.02];
          const elbow: [number, number, number] = [side * 0.27, 0.48, 0.26];
          const wrist: [number, number, number] = [
            side * 0.12,
            REST_Y + 0.05,
            0.56,
          ];
          return (
            <group key={side}>
              {/* Upper arm, shawl-covered. */}
              <Limb
                from={shoulder}
                to={elbow}
                radius={0.062}
                tipRadius={0.054}
                color={SHAWL}
                roughness={0.9}
              />
              {/* Forearm, in shirtsleeve. */}
              <Limb
                from={elbow}
                to={wrist}
                radius={0.052}
                tipRadius={0.046}
                color={SHIRT}
                roughness={0.68}
              />
              {/* Cuff at the wrist. */}
              <mesh position={wrist}>
                <sphereGeometry args={[0.05, 10, 8]} />
                <meshStandardMaterial color={SHIRT} roughness={0.6} />
              </mesh>
            </group>
          );
        })}

        {/* Clasped hands, resting on the table surface. */}
        <mesh position={[0, REST_Y + 0.06, 0.65]} castShadow>
          <sphereGeometry args={[0.075, 12, 9]} />
          <meshStandardMaterial color={SKIN} roughness={0.66} />
        </mesh>

        {/* Neck. */}
        <mesh position={[0, 0.76, 0.01]}>
          <cylinderGeometry args={[0.058, 0.068, 0.16, 10]} />
          <meshStandardMaterial color={SKIN_SHADE} roughness={0.68} />
        </mesh>

        <group ref={head} position={[0, 0.86, 0.01]}>
          {/**
           * The face.
           *
           * Longer than wide and slightly flattened front-to-back, which is most
           * of what stops a head reading as a ball with features stuck on it.
           * Everything below is placed against this scale, so change it and the
           * whole face moves together.
           */}
          <mesh scale={[1, 1.14, 0.98]} castShadow>
            <sphereGeometry args={[0.142, 20, 16]} />
            <meshStandardMaterial color={SKIN} roughness={0.66} />
          </mesh>

          {/* Cheekbones, and a jaw narrowing to the chin. */}
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              position={[side * 0.088, -0.012, 0.078]}
              scale={[1, 0.8, 0.7]}
            >
              <sphereGeometry args={[0.052, 12, 10]} />
              <meshStandardMaterial color={SKIN} roughness={0.68} />
            </mesh>
          ))}
          <mesh position={[0, -0.11, 0.058]} scale={[1, 0.85, 0.9]}>
            <sphereGeometry args={[0.062, 14, 12]} />
            <meshStandardMaterial color={SKIN} roughness={0.68} />
          </mesh>

          {/* Ears, flattened against the skull. */}
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              position={[side * 0.142, -0.008, 0.004]}
              scale={[0.45, 1, 0.72]}
            >
              <sphereGeometry args={[0.032, 10, 8]} />
              <meshStandardMaterial color={SKIN_SHADE} roughness={0.7} />
            </mesh>
          ))}

          {/* Brow ridge. A heavy one, and it does more for the face than any
              other single piece here. */}
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              position={[side * 0.052, 0.048, 0.116]}
              rotation={[0, 0, side * -0.1]}
            >
              <boxGeometry args={[0.058, 0.016, 0.026]} />
              <meshStandardMaterial color="#5a4a3c" roughness={0.9} />
            </mesh>
          ))}

          {/* Nose: bridge down from between the brows, then a tip. */}
          <mesh position={[0, 0.004, 0.128]} rotation={[0.1, 0, 0]}>
            <boxGeometry args={[0.03, 0.075, 0.036]} />
            <meshStandardMaterial color={SKIN} roughness={0.66} />
          </mesh>
          <mesh position={[0, -0.036, 0.142]}>
            <sphereGeometry args={[0.023, 10, 8]} />
            <meshStandardMaterial color={SKIN} roughness={0.64} />
          </mesh>

          {/* Eyes, set back so the frames sit proud of them. */}
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              position={[side * 0.053, 0.014, 0.112]}
              scale={[1, 0.72, 0.6]}
            >
              <sphereGeometry args={[0.019, 10, 8]} />
              <meshStandardMaterial color="#2a2622" roughness={0.32} />
            </mesh>
          ))}

          {/**
           * The specs.
           *
           * Heavy rounded frames in dark tortoise, sitting on the nose and
           * hooking back over the ears. Built as real parts — rim, lens, bridge,
           * temple arm — because a single flat plate reads as a painted-on decal
           * the moment the head turns, and this head turns constantly.
           */}
          {[-1, 1].map((side) => (
            <group key={side}>
              <mesh position={[side * 0.055, 0.014, 0.128]}>
                <torusGeometry args={[0.046, 0.009, 8, 20]} />
                <meshStandardMaterial
                  color={FRAME}
                  roughness={0.34}
                  metalness={0.18}
                />
              </mesh>
              {/* Lens. Barely there, but it catches the key light. */}
              <mesh
                position={[side * 0.055, 0.014, 0.127]}
                rotation={[Math.PI / 2, 0, 0]}
              >
                <cylinderGeometry args={[0.044, 0.044, 0.003, 20]} />
                <meshStandardMaterial
                  color="#cfd8dc"
                  transparent
                  opacity={0.18}
                  roughness={0.1}
                  metalness={0.3}
                />
              </mesh>
              {/* Temple arm, back to the ear. */}
              <mesh
                position={[side * 0.113, 0.02, 0.062]}
                rotation={[0, side * -0.22, 0]}
              >
                <boxGeometry args={[0.014, 0.013, 0.14]} />
                <meshStandardMaterial color={FRAME} roughness={0.36} />
              </mesh>
            </group>
          ))}
          {/* Bridge across the nose. */}
          <mesh position={[0, 0.026, 0.132]}>
            <boxGeometry args={[0.028, 0.011, 0.014]} />
            <meshStandardMaterial color={FRAME} roughness={0.34} />
          </mesh>

          {/* Mouth, mostly covered by the moustache above it. */}
          <mesh position={[0, -0.074, 0.122]} scale={[1, 0.4, 0.5]}>
            <sphereGeometry args={[0.03, 10, 8]} />
            <meshStandardMaterial color="#7d4f42" roughness={0.7} />
          </mesh>

          {/**
           * French cut: a full silver moustache, a chin patch, and the two
           * narrow lines down the sides of the mouth that join them. What makes
           * it *that* beard rather than a goatee is precisely those connectors
           * plus the bare jaw either side — so the jawline stays clean.
           */}
          <mesh position={[0, -0.056, 0.126]} scale={[1.75, 0.5, 0.62]}>
            <sphereGeometry args={[0.033, 12, 10]} />
            <meshStandardMaterial color={SILVER} roughness={0.95} />
          </mesh>
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              position={[side * 0.042, -0.086, 0.114]}
              rotation={[0, 0, side * 0.22]}
            >
              <boxGeometry args={[0.017, 0.056, 0.026]} />
              <meshStandardMaterial color={SILVER} roughness={0.95} />
            </mesh>
          ))}
          <mesh position={[0, -0.116, 0.098]} scale={[1.25, 1, 0.72]}>
            <sphereGeometry args={[0.042, 12, 10]} />
            <meshStandardMaterial color={SILVER} roughness={0.95} />
          </mesh>

          {/**
           * Hair: volume on top, swept off the forehead, sideburns gone grey.
           * The sweep is deliberately off-centre — a symmetrical cap is what
           * makes low-poly hair look like a helmet.
           */}
          <mesh position={[0, 0.028, -0.014]} scale={[1, 1.06, 1.02]}>
            <sphereGeometry
              args={[0.152, 18, 14, 0, Math.PI * 2, 0, Math.PI / 1.85]}
            />
            <meshStandardMaterial color={HAIR} roughness={0.94} />
          </mesh>
          {/* The fringe, swept to one side across the brow. */}
          <mesh
            position={[-0.022, 0.098, 0.062]}
            rotation={[0.42, 0.16, 0.12]}
            scale={[1.45, 0.42, 1]}
          >
            <sphereGeometry args={[0.088, 14, 12]} />
            <meshStandardMaterial color={HAIR} roughness={0.94} />
          </mesh>
          {/* Sideburns, greying. */}
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              position={[side * 0.132, 0.006, 0.022]}
              scale={[0.4, 1, 0.62]}
            >
              <sphereGeometry args={[0.05, 10, 10]} />
              <meshStandardMaterial color="#8d857c" roughness={0.95} />
            </mesh>
          ))}
        </group>
      </group>

      {/**
       * His chair — the same task chair everyone else has, rather than the bare
       * backrest slab that used to stand in for it.
       *
       * Offset down by `SEAT_Y` because this group is raised to seat height, and
       * a chair whose base is 42cm off the carpet is a chair floating in the air.
       */}
      <TaskChair position={[0, -SEAT_Y, -CHAIR_SET_BACK]} />
    </group>
  );
}

export { TABLE };

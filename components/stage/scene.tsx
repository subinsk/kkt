"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { PublicGame } from "@/lib/game/state";
import { Host, HOST_POSITION } from "./host";
import { Contestants, SEAT_POSITIONS } from "./contestants";
import { WirePanel, PANEL_POSITION } from "./wire-panel";
import { Room, ROOM } from "./room";
import { Table, DeskProps } from "./furniture";
import { Confetti, Fire } from "./effects";

/**
 * The set.
 *
 * A corporate meeting room shot from behind the contestants: their backs in the
 * near foreground, the oval table, the host front-facing across it, and the
 * five-wire panel mounted on the wall behind him.
 *
 * The framing is the point. Putting the camera in the contestants' seats makes
 * the projector a first-person view of the game — the audience is *at the table*
 * rather than watching a diorama of one. It also means the wire panel has to be
 * on the wall: anything on the table would be hidden behind three heads.
 *
 * Escalation is built into the camera and the lighting rather than bolted on.
 * Above a minute it sits back under neutral office light; under a minute it
 * pushes in and the room goes red. The room should feel the clock without
 * anybody reading it.
 */

export function Scene({
  game,
  agentLevelRef,
  minimal,
  interactive = false,
  userDriving,
}: {
  game: PublicGame;
  agentLevelRef: React.RefObject<number>;
  minimal: boolean;
  interactive?: boolean;
  /** Set true the moment the user grabs the camera. */
  userDriving?: React.RefObject<boolean>;
}) {
  return (
    <>
      <CameraRig game={game} userDriving={userDriving} />

      {/**
       * Drag to orbit, scroll to zoom, right-drag to pan.
       *
       * `makeDefault` matters: it registers these controls so anything else
       * asking three.js for "the" controls finds them. The polar clamp stops you
       * dropping the camera through the carpet, and the distance clamp stops you
       * ending up inside the host's head or out in the car park.
       */}
      {interactive && (
        <OrbitControls
          makeDefault
          target={LOOK_AT}
          enablePan
          enableZoom
          enableRotate
          enableDamping
          dampingFactor={0.08}
          minDistance={1.4}
          maxDistance={11}
          maxPolarAngle={Math.PI / 2.04}
          onStart={() => {
            if (userDriving) userDriving.current = true;
          }}
        />
      )}
      <Lighting game={game} />

      <Room game={game} />
      <Table />
      <DeskProps />

      <WirePanel game={game} minimal={minimal} />
      <Host game={game} levelRef={agentLevelRef} seatPositions={SEAT_POSITIONS} />
      <Contestants game={game} />

      {!minimal && (
        <>
          {/* Both burst from the panel on the wall, which is where the device is. */}
          <Confetti active={game.phase === "won"} origin={[0, 1.9, -2.9]} />
          <Fire active={game.phase === "lost"} origin={[0, 1.75, -2.95]} />
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Over-the-shoulder, slightly high — the angle a room camera would actually be
 * mounted at, above and behind the near seats.
 */
export const CAMERA_HOME: [number, number, number] = [0, 2.42, 4.35];
const LOOK_AT = new THREE.Vector3(0, 1.32, -1.6);

function CameraRig({
  game,
  userDriving,
}: {
  game: PublicGame;
  userDriving?: React.RefObject<boolean>;
}) {
  const { camera } = useThree();
  const push = useRef(0);
  const shake = useRef(0);
  const lastPhase = useRef(game.phase);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const panic = game.secondsLeft <= 60 && game.phase === "running";

    // Once the user has grabbed the camera, stop moving it under them. Two
    // things writing camera.position every frame is a fight the user always
    // loses, and it feels like the scene is shoving your hand away.
    if (userDriving?.current) return;

    // Fire the shake once, on the transition into a loss.
    if (lastPhase.current !== game.phase) {
      if (game.phase === "lost") shake.current = 1;
      lastPhase.current = game.phase;
    }

    push.current = THREE.MathUtils.lerp(push.current, panic ? 1 : 0, delta * 1.1);

    // Pushes in and drops slightly — past the shoulders, closer to the host.
    const z = CAMERA_HOME[2] - push.current * 1.25;
    const y = CAMERA_HOME[1] - push.current * 0.3;

    // Slow drift, so a static shot never looks like a frozen frame.
    const driftX = Math.sin(t * 0.15) * 0.09;
    const driftY = Math.cos(t * 0.19) * 0.035;

    let shakeX = 0;
    let shakeY = 0;
    if (shake.current > 0.001) {
      shake.current *= Math.pow(0.02, delta); // ~500ms decay
      shakeX = (Math.random() - 0.5) * shake.current * 0.36;
      shakeY = (Math.random() - 0.5) * shake.current * 0.36;
    }

    camera.position.set(driftX + shakeX, y + driftY + shakeY, z);
    camera.lookAt(LOOK_AT);

    if (camera instanceof THREE.PerspectiveCamera) {
      // FOV punch on the detonation, per the §10.3 beat sheet.
      const punch = shake.current > 0.001 ? shake.current * 12 : 0;
      const fov = 40 + push.current * 3 + punch;
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }
  });

  return null;
}

/* -------------------------------------------------------------------------- */
/* Lighting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Office lighting, not studio lighting.
 *
 * Neutral overhead fluorescents, cool daylight from the window on the right, and
 * a soft bounce off the pale table. The only theatrical light in the room is the
 * host's own warm key, which lives in `host.tsx` so it can react to his voice.
 *
 * Under a minute the whole room shifts red and the overheads pulse. That is the
 * one moment the fiction allows itself to stop being an office.
 */
function Lighting({ game }: { game: PublicGame }) {
  const overhead = useRef<THREE.DirectionalLight>(null);
  const panic = useRef(0);
  const redWash = useRef<THREE.PointLight>(null);
  const fill = useRef<THREE.AmbientLight>(null);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const isPanic = game.secondsLeft <= 60 && game.phase === "running";
    const won = game.phase === "won";

    panic.current = THREE.MathUtils.lerp(
      panic.current,
      isPanic ? 1 : 0,
      delta * 2.2,
    );

    if (overhead.current) {
      // Overheads dip and flicker on the beat as the clock runs down.
      const flicker = panic.current * Math.abs(Math.sin(t * 3.2)) * 0.5;
      overhead.current.intensity = 1.5 - panic.current * 0.55 + flicker;
      overhead.current.color.lerp(
        new THREE.Color(won ? "#eaf6ff" : isPanic ? "#ffd0c4" : "#fff6e8"),
        delta * 2,
      );
    }

    if (redWash.current) {
      redWash.current.intensity =
        panic.current * (2.4 + Math.sin(t * 3.2) * 1.1);
    }

    if (fill.current) {
      fill.current.intensity = 0.5 - panic.current * 0.16;
    }
  });

  return (
    <>
      {/* Broad fill. An office is a bright, low-contrast place. */}
      <ambientLight ref={fill} intensity={0.5} color="#fdf6ea" />

      {/* Ceiling panels, as one soft directional with a shadow. */}
      <directionalLight
        ref={overhead}
        position={[1.2, 4.2, 1.6]}
        intensity={1.5}
        color="#fff6e8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0006}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-far={16}
      />

      {/* Cool daylight from the window on the right wall. */}
      <directionalLight
        position={[6.5, 2.4, -0.8]}
        intensity={0.85}
        color="#cfe4ff"
      />

      {/* Bounce off the pale table, up into the faces. Small but it is what
          keeps the underside of the host's jaw from going black. */}
      <pointLight position={[0, 0.95, -0.4]} intensity={0.4} color="#fff2dc" distance={4} />

      {/* Panic wash, over the whole room. */}
      <pointLight
        ref={redWash}
        position={[0, 2.3, -1.2]}
        color="#ff2a1e"
        intensity={0}
        distance={ROOM.depth}
      />
    </>
  );
}

export { HOST_POSITION, PANEL_POSITION };

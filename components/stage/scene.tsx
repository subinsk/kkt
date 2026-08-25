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
import type { HostLine } from "@/lib/use-host-line";
import { SpeechBubble } from "./speech-bubble";

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
  hostLine = null,
  lineStatus = null,
  wordsPerSecond = null,
  onLineDone,
}: {
  game: PublicGame;
  agentLevelRef: React.RefObject<number>;
  minimal: boolean;
  interactive?: boolean;
  /** Set true the moment the user grabs the camera. */
  userDriving?: React.RefObject<boolean>;
  /** The host's current line, typed out above his head. */
  hostLine?: HostLine | null;
  /** The ledger's status for that line, or null when nobody is reporting acks. */
  lineStatus?: string | null;
  /** Measured speaking rate, for pacing the reveal. */
  wordsPerSecond?: number | null;
  /** Fired when that line is finished, so the queue can hand over the next. */
  onLineDone?: () => void;
}) {
  return (
    <>
      <CameraRig game={game} userDriving={userDriving} />

      {/**
       * Drag to orbit, scroll to zoom, right-drag to pan.
       *
       * `makeDefault` matters: it registers these controls so anything else
       * asking three.js for "the" controls finds them. The polar clamp stops you
       * dropping the camera through the carpet; `CameraBounds` below stops you
       * ending up inside the host's head or outside the room looking at a wall.
       */}
      {interactive && (
        <>
          <OrbitControls
            makeDefault
            target={LOOK_AT}
            enablePan
            enableZoom
            enableRotate
            enableDamping
            dampingFactor={0.08}
            minDistance={MIN_ORBIT}
            maxDistance={MAX_ORBIT}
            minPolarAngle={0.3}
            maxPolarAngle={Math.PI / 2.04}
            onStart={() => {
              if (userDriving) userDriving.current = true;
            }}
          />
          <CameraBounds />
        </>
      )}
      <Lighting game={game} />

      <Room game={game} />
      <Table />
      <DeskProps />

      <WirePanel game={game} minimal={minimal} />
      <Host game={game} levelRef={agentLevelRef} seatPositions={SEAT_POSITIONS} />
      <Contestants game={game} />

      {/* Above and slightly in front of the host's head, wherever that is. */}
      {/* Same level ref the head-bob reads: the bubble opens when he is
          audibly speaking, not when his line arrives from the proxy. */}
      <SpeechBubble
        line={hostLine}
        status={lineStatus}
        wordsPerSecond={wordsPerSecond}
        onDone={onLineDone}
        levelRef={agentLevelRef}
        position={[HOST_POSITION[0], 1.78, HOST_POSITION[2] + 0.34]}
      />

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
/**
 * Far enough back to hold the near chairs.
 *
 * At 3.95 the bottom of frame cut through y≈1.29 at the front row's depth, and
 * their chair backs top out at 1.14 — so the three contestants sat on nothing.
 * Pulling back is what buys foreground, not raising the camera: lifting it
 * pitches the frustum down and the near cutoff barely moves.
 */
export const CAMERA_HOME: [number, number, number] = [0, 2.38, 4.8];

/**
 * The host's head, which is what this shot is about. Keyed off `HOST_POSITION`
 * rather than a literal, so moving him around the table re-aims the camera
 * instead of leaving it staring at where he used to sit.
 */
const LOOK_AT = new THREE.Vector3(0, 1.26, HOST_POSITION[2] + 0.2);

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
/* Camera bounds                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The camera may never leave the room.
 *
 * The set is a real box, not a backdrop: the back wall is sixteen solid boards
 * and the window frame is solid boxes, so an orbit that swings outside the shell
 * lands you looking at the *back* of the room — a slab of wood filling frame.
 * Swing past a side wall instead and it disappears entirely (those are
 * single-sided planes) leaving a hole into the void. Either way the view is
 * gone, and on a projector mid-game that is unrecoverable.
 *
 * Rather than forbidding angles — which makes the drag feel broken, and is
 * fragile because panning moves the target and invalidates any fixed clamp —
 * the orbit *radius* is shortened to whatever keeps the camera this side of the
 * nearest surface. You can still look from anywhere; rotating towards a wall
 * simply draws you in rather than through.
 */

/** Outer cap, before the room is taken into account. */
const MAX_ORBIT = 9;

/** Room interior, held off the surfaces so the near plane never clips one. */
const WALL_MARGIN = 0.34;
const BOUND_MIN = new THREE.Vector3(
  -ROOM.width / 2 + WALL_MARGIN,
  0.4,
  ROOM.backZ + WALL_MARGIN,
);
const BOUND_MAX = new THREE.Vector3(
  ROOM.width / 2 - WALL_MARGIN,
  ROOM.height - 0.24,
  // No front wall — but the carpet and ceiling stop, so past this you would be
  // looking at the room from off the end of the floor.
  5.6,
);

/**
 * Where a pan is allowed to put the point of interest. Tighter than the room:
 * the target is what the camera orbits, so letting it reach a wall would leave
 * no usable radius at all.
 */
const TARGET_MIN = new THREE.Vector3(-2.6, 0.6, ROOM.backZ + 0.8);
const TARGET_MAX = new THREE.Vector3(2.6, 2.4, 3.0);

/** Distance from `origin` along unit `dir` at which the interior box is left. */
function distanceToWall(origin: THREE.Vector3, dir: THREE.Vector3) {
  let t = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const d = dir[axis];
    if (Math.abs(d) < 1e-6) continue;
    const bound = d > 0 ? BOUND_MAX[axis] : BOUND_MIN[axis];
    t = Math.min(t, (bound - origin[axis]) / d);
  }
  // The target is clamped inside the box, so this is non-negative in practice.
  return Math.max(0, t);
}

type Orbit = {
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
};

/** Resting close limit — far enough back to not be inside the host's head. */
const MIN_ORBIT = 1.4;

function CameraBounds() {
  const controls = useThree((state) => state.controls) as Orbit | null;
  const camera = useThree((state) => state.camera);
  const offset = useRef(new THREE.Vector3());

  useFrame(() => {
    // `makeDefault` registers the controls a frame or two after mount.
    if (!controls?.target) return;

    controls.target.clamp(TARGET_MIN, TARGET_MAX);

    const dir = offset.current.copy(camera.position).sub(controls.target);
    const distance = dir.length();
    if (distance < 1e-4) return;
    dir.divideScalar(distance);

    const limit = THREE.MathUtils.clamp(
      distanceToWall(controls.target, dir),
      0.4,
      MAX_ORBIT,
    );

    // Both ends, because a wall closer than the resting minimum has to win —
    // being inside the panelling is worse than being close to the host — and
    // OrbitControls resolves a crossed pair in favour of the minimum, which
    // would fight the correction below every frame.
    controls.minDistance = Math.min(MIN_ORBIT, limit);
    // Set for the next update: OrbitControls runs at priority -1, so its own
    // clamp has already happened by the time we get here...
    controls.maxDistance = limit;
    // ...which is why the current frame is corrected by hand. Without this the
    // wall would flash into frame for one frame on a fast drag.
    if (distance > limit) {
      camera.position.copy(controls.target).addScaledVector(dir, limit);
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

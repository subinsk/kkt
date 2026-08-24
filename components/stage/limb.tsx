"use client";

import * as THREE from "three";

/**
 * A limb segment, defined by its two ends.
 *
 * Every arm in this set used to be a cylinder with a hand-tuned Euler rotation,
 * and that is a losing game: the rotation determines where the ends land, so
 * moving a shoulder or dropping a hand onto the table means re-deriving two
 * angles by trigonometry or living with a gap. They were left with a gap — a
 * visible one, roughly twenty centimetres of daylight between elbow and forearm.
 *
 * Here the joints are the inputs and the geometry is computed from them, so a
 * segment cannot be disconnected from the joint it is supposed to meet. Place
 * the shoulder, elbow and wrist; the arm follows.
 */
export function Limb({
  from,
  to,
  radius,
  tipRadius = radius,
  color,
  roughness = 0.75,
  segments = 8,
}: {
  /** Start joint, in the parent group's coordinates. */
  from: [number, number, number];
  /** End joint. `tipRadius` applies at this end. */
  to: [number, number, number];
  radius: number;
  tipRadius?: number;
  color: string;
  roughness?: number;
  segments?: number;
}) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);

  const dir = b.clone().sub(a);
  const length = dir.length();
  if (length < 1e-6) return null;

  // A cylinder is built along +Y, so this is the rotation that lays it along
  // the joint-to-joint axis. No Euler angles anywhere, which is the point.
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize(),
  );

  return (
    <mesh
      position={a.clone().add(b).multiplyScalar(0.5)}
      quaternion={quaternion}
      castShadow
    >
      {/* args are (radiusTop, radiusBottom, …) and +Y is `to`, so the tip
          radius belongs first. */}
      <cylinderGeometry args={[tipRadius, radius, length, segments]} />
      <meshStandardMaterial color={color} roughness={roughness} />
    </mesh>
  );
}

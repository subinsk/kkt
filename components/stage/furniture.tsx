"use client";

import { useMemo } from "react";
import * as THREE from "three";

/**
 * The boardroom table and chairs.
 *
 * The table is an oval with a hole through the middle — a real racetrack
 * conference table, not a slab. That hole matters more than it sounds: it is
 * what makes the host feel across from the contestants rather than beside them,
 * and it gives the camera a dark void in the near foreground that the backs of
 * the contestants' heads read against.
 */

export const TABLE = {
  center: [0, 0, -0.35] as [number, number, number],
  height: 0.74,
  outerX: 2.95,
  outerZ: 2.15,
  innerX: 1.62,
  innerZ: 1.0,
};

export function Table() {
  /**
   * Extruded from a Shape with a hole, so the top is genuinely a ring rather
   * than two overlapping discs. Ellipses are approximated with absellipse,
   * which handles both the outline and the hole.
   */
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, TABLE.outerX, TABLE.outerZ, 0, Math.PI * 2, false, 0);

    const hole = new THREE.Path();
    hole.absellipse(0, 0, TABLE.innerX, TABLE.innerZ, 0, Math.PI * 2, true, 0);
    shape.holes.push(hole);

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.06,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.014,
      bevelSegments: 2,
      curveSegments: 48,
    });
    // Extrudes along +Z, so lay it flat.
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }, []);

  const edgeGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, TABLE.outerX, TABLE.outerZ, 0, Math.PI * 2, false, 0);
    const hole = new THREE.Path();
    hole.absellipse(
      0,
      0,
      TABLE.outerX - 0.05,
      TABLE.outerZ - 0.05,
      0,
      Math.PI * 2,
      true,
      0,
    );
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.07,
      bevelEnabled: false,
      curveSegments: 48,
    });
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }, []);

  return (
    <group position={[TABLE.center[0], 0, TABLE.center[2]]}>
      {/* Top — pale laminate, the standard meeting-room surface. */}
      <mesh
        geometry={geometry}
        position={[0, TABLE.height, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#ddd2bd" roughness={0.42} metalness={0.05} />
      </mesh>

      {/* Dark edge band, which is what stops the top looking like a flat cutout. */}
      <mesh geometry={edgeGeometry} position={[0, TABLE.height - 0.065, 0]}>
        <meshStandardMaterial color="#4a4038" roughness={0.6} metalness={0.15} />
      </mesh>

      {/* Modesty panel dropping into the hole — gives the void depth. */}
      <mesh position={[0, TABLE.height - 0.34, 0]}>
        <cylinderGeometry
          args={[TABLE.innerX * 0.96, TABLE.innerX * 0.96, 0.62, 40, 1, true]}
        />
        <meshStandardMaterial
          color="#2a231d"
          roughness={0.85}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Plinth base */}
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[TABLE.innerX * 0.8, TABLE.innerX * 0.85, 0.1, 32]} />
        <meshStandardMaterial color="#28241f" roughness={0.8} />
      </mesh>
    </group>
  );
}

/**
 * A task chair, seen mostly from behind.
 *
 * Simplified hard: from the camera's position you see the back of the mesh and
 * the top of the base, so that is where the detail goes. The armrests exist
 * because their silhouette is what makes it read as an office chair rather than
 * a dining chair.
 */
export function TaskChair({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Backrest — slight recline, which every task chair has. */}
      <mesh position={[0, 0.72, -0.16]} rotation={[-0.11, 0, 0]} castShadow>
        <boxGeometry args={[0.5, 0.62, 0.06]} />
        <meshStandardMaterial color="#17171a" roughness={0.82} />
      </mesh>
      {/* Headrest */}
      <mesh position={[0, 1.06, -0.2]} rotation={[-0.14, 0, 0]} castShadow>
        <boxGeometry args={[0.34, 0.16, 0.05]} />
        <meshStandardMaterial color="#17171a" roughness={0.82} />
      </mesh>
      {/* Seat pan */}
      <mesh position={[0, 0.44, 0.02]} castShadow>
        <boxGeometry args={[0.48, 0.08, 0.46]} />
        <meshStandardMaterial color="#1b1b1e" roughness={0.85} />
      </mesh>
      {/* Armrests */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.28, 0.58, 0.02]} castShadow>
          <boxGeometry args={[0.05, 0.04, 0.3]} />
          <meshStandardMaterial color="#15151a" roughness={0.7} />
        </mesh>
      ))}
      {/* Gas cylinder */}
      <mesh position={[0, 0.22, 0.02]}>
        <cylinderGeometry args={[0.045, 0.045, 0.42, 10]} />
        <meshStandardMaterial color="#2a2a2e" roughness={0.4} metalness={0.7} />
      </mesh>
      {/* Five-star base */}
      {Array.from({ length: 5 }).map((_, i) => {
        const a = (i / 5) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 0.16, 0.04, Math.sin(a) * 0.16 + 0.02]}
            rotation={[0, -a, 0]}
          >
            <boxGeometry args={[0.3, 0.03, 0.05]} />
            <meshStandardMaterial color="#232327" roughness={0.5} metalness={0.5} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * Desk props: an open laptop, mugs, a water glass, papers.
 *
 * Entirely non-functional and worth every triangle. An empty conference table
 * looks like a 3D scene; a table with somebody's coffee on it looks like a room
 * people are actually sitting in.
 */
export function DeskProps() {
  return (
    <group>
      {/* Laptop in front of the centre contestant, screen facing away from us. */}
      <group position={[0.02, TABLE.height, 1.06]} rotation={[0, Math.PI, 0]}>
        <mesh position={[0, 0.005, 0]} castShadow>
          <boxGeometry args={[0.34, 0.012, 0.24]} />
          <meshStandardMaterial color="#3a3d42" roughness={0.35} metalness={0.75} />
        </mesh>
        <mesh position={[0, 0.11, -0.12]} rotation={[-0.28, 0, 0]} castShadow>
          <boxGeometry args={[0.34, 0.22, 0.01]} />
          <meshStandardMaterial color="#2e3136" roughness={0.35} metalness={0.7} />
        </mesh>
        {/* The lit screen, angled away — a cool spill onto the table. */}
        <mesh position={[0, 0.11, -0.114]} rotation={[-0.28, 0, 0]}>
          <planeGeometry args={[0.31, 0.19]} />
          <meshBasicMaterial color="#cfe4f5" toneMapped={false} />
        </mesh>
      </group>

      <Mug position={[-0.72, TABLE.height, 1.24]} />
      <Mug position={[0.82, TABLE.height, 1.2]} />
      <Mug position={[1.02, TABLE.height, 1.05]} />

      {/* Water glass */}
      <mesh position={[-0.95, TABLE.height + 0.055, 1.05]} castShadow>
        <cylinderGeometry args={[0.038, 0.033, 0.11, 14]} />
        <meshStandardMaterial
          color="#dceaf2"
          roughness={0.08}
          metalness={0.05}
          transparent
          opacity={0.5}
        />
      </mesh>

      {/* Papers */}
      <mesh
        position={[-1.35, TABLE.height + 0.003, 0.92]}
        rotation={[-Math.PI / 2, 0, 0.22]}
      >
        <planeGeometry args={[0.22, 0.3]} />
        <meshStandardMaterial color="#f3f1ec" roughness={0.95} />
      </mesh>
      <mesh
        position={[1.3, TABLE.height + 0.003, 0.86]}
        rotation={[-Math.PI / 2, 0, -0.16]}
      >
        <planeGeometry args={[0.22, 0.3]} />
        <meshStandardMaterial color="#f3f1ec" roughness={0.95} />
      </mesh>

      {/* Host's own notes, so his side of the table is not bare. */}
      <mesh
        position={[0.34, TABLE.height + 0.003, -1.42]}
        rotation={[-Math.PI / 2, 0, 0.1]}
      >
        <planeGeometry args={[0.2, 0.28]} />
        <meshStandardMaterial color="#f3f1ec" roughness={0.95} />
      </mesh>
    </group>
  );
}

function Mug({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.045, 0]} castShadow>
        <cylinderGeometry args={[0.042, 0.038, 0.09, 14]} />
        <meshStandardMaterial color="#f2efe9" roughness={0.42} />
      </mesh>
      {/* Coffee */}
      <mesh position={[0, 0.086, 0]}>
        <cylinderGeometry args={[0.036, 0.036, 0.004, 14]} />
        <meshStandardMaterial color="#3a241a" roughness={0.35} />
      </mesh>
      {/* Handle */}
      <mesh position={[0.05, 0.048, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.022, 0.006, 6, 12, Math.PI]} />
        <meshStandardMaterial color="#f2efe9" roughness={0.42} />
      </mesh>
    </group>
  );
}

"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * The endgame beats — spec §10.3 and §10.4.
 *
 * The last four seconds are what the room remembers, so both outcomes get a
 * choreographed visual. No extra libraries: confetti is one InstancedMesh, fire
 * is additive billboard points with a canvas gradient. Cheap enough to run
 * alongside WebRTC on an unfamiliar laptop, which is a real constraint.
 *
 * Tone note, and it matters: the fire is deliberately CARTOONISH. Orange and
 * yellow, comic, confetti-adjacent. The fiction is a prank device in an office;
 * a realistic detonation inside a corporate venue is the wrong note, and the
 * comedy version is both funnier and safer.
 */

/* -------------------------------------------------------------------------- */
/* Confetti — the win                                                         */
/* -------------------------------------------------------------------------- */

const CONFETTI_COUNT = 420;
const CONFETTI_COLORS = [
  "#c9973f",
  "#e8bd6d",
  "#3dd68c",
  "#4ac8ff",
  "#ff6b4a",
  "#ffd24a",
  "#f2ece2",
];

export function Confetti({
  active,
  origin = [0, 1.1, 0],
}: {
  active: boolean;
  origin?: [number, number, number];
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const elapsed = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const particles = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, () => {
        // Upward cone, wide spread. Real confetti goes up first.
        const theta = Math.random() * Math.PI * 2;
        const speed = 1.6 + Math.random() * 3.2;
        const rise = 2.4 + Math.random() * 2.6;
        return {
          velocity: new THREE.Vector3(
            Math.cos(theta) * speed * 0.45,
            rise,
            Math.sin(theta) * speed * 0.45,
          ),
          spin: new THREE.Vector3(
            (Math.random() - 0.5) * 9,
            (Math.random() - 0.5) * 9,
            (Math.random() - 0.5) * 9,
          ),
          rotation: new THREE.Vector3(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI,
          ),
          position: new THREE.Vector3(),
          // Varying drag is what stops 420 quads moving as one sheet.
          drag: 0.86 + Math.random() * 0.1,
          scale: 0.7 + Math.random() * 0.6,
        };
      }),
    [],
  );

  const colors = useMemo(() => {
    const array = new Float32Array(CONFETTI_COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      array[i * 3] = c.r;
      array[i * 3 + 1] = c.g;
      array[i * 3 + 2] = c.b;
    }
    return array;
  }, []);

  useFrame((_, delta) => {
    if (!mesh.current) return;

    if (!active) {
      elapsed.current = 0;
      mesh.current.visible = false;
      return;
    }

    mesh.current.visible = true;
    if (elapsed.current === 0) {
      for (const p of particles) p.position.set(...origin);
    }
    elapsed.current += delta;

    const step = Math.min(delta, 1 / 30);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      p.velocity.y -= 6.2 * step; // gravity
      p.velocity.multiplyScalar(Math.pow(p.drag, step * 60));
      p.position.addScaledVector(p.velocity, step);

      p.rotation.x += p.spin.x * step;
      p.rotation.y += p.spin.y * step;
      p.rotation.z += p.spin.z * step;

      // Cull below the desk plane by parking it out of frame.
      const dead = p.position.y < -0.4;

      dummy.position.copy(p.position);
      dummy.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
      dummy.scale.setScalar(dead ? 0 : p.scale);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, CONFETTI_COUNT]}
      visible={false}
    >
      <planeGeometry args={[0.055, 0.026]}>
        <instancedBufferAttribute
          attach="attributes-color"
          args={[colors, 3]}
        />
      </planeGeometry>
      <meshStandardMaterial
        vertexColors
        side={THREE.DoubleSide}
        roughness={0.4}
        metalness={0.25}
        emissiveIntensity={0.2}
      />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Fire — the loss                                                            */
/* -------------------------------------------------------------------------- */

const FIRE_COUNT = 560;

/** Radial gradient sprite: white core → orange → transparent. */
function fireTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,240,1)");
  g.addColorStop(0.35, "rgba(255,170,40,0.9)");
  g.addColorStop(1, "rgba(255,60,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function Fire({
  active,
  origin = [0, 1.0, 0],
}: {
  active: boolean;
  origin?: [number, number, number];
}) {
  const points = useRef<THREE.Points>(null);
  const light = useRef<THREE.PointLight>(null);
  const elapsed = useRef(0);
  const texture = useMemo(fireTexture, []);

  const state = useMemo(() => {
    const positions = new Float32Array(FIRE_COUNT * 3);
    const colors = new Float32Array(FIRE_COUNT * 3);
    const velocities: THREE.Vector3[] = [];
    const life = new Float32Array(FIRE_COUNT);
    const maxLife = new Float32Array(FIRE_COUNT);

    for (let i = 0; i < FIRE_COUNT; i++) {
      // First ~300 are the initial burst: high outward velocity, spherical.
      const burst = i < 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = burst ? 1.4 + Math.random() * 2.6 : 0.15 + Math.random() * 0.4;

      velocities.push(
        new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta) * speed,
          burst ? Math.abs(Math.cos(phi)) * speed + 0.6 : 0.7 + Math.random() * 0.7,
          Math.sin(phi) * Math.sin(theta) * speed,
        ),
      );
      maxLife[i] = burst ? 0.7 + Math.random() * 0.6 : 1.4 + Math.random() * 1.6;
      // The plume emitter staggers its spawns so it feeds continuously.
      life[i] = burst ? 0 : -Math.random() * 2.2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    return { geometry, velocities, life, maxLife };
  }, []);

  useFrame((_, delta) => {
    if (!points.current) return;

    if (!active) {
      elapsed.current = 0;
      points.current.visible = false;
      if (light.current) light.current.intensity = 0;
      return;
    }

    points.current.visible = true;
    elapsed.current += delta;
    const step = Math.min(delta, 1 / 30);

    const pos = state.geometry.attributes.position as THREE.BufferAttribute;
    const col = state.geometry.attributes.color as THREE.BufferAttribute;

    for (let i = 0; i < FIRE_COUNT; i++) {
      state.life[i] += step;
      const age = state.life[i];

      if (age < 0) {
        pos.setXYZ(i, 0, -999, 0);
        continue;
      }

      if (age > state.maxLife[i]) {
        // Recycle into the plume rather than dying, so the fire keeps burning.
        state.life[i] = 0;
        state.velocities[i].set(
          (Math.random() - 0.5) * 0.35,
          0.7 + Math.random() * 0.7,
          (Math.random() - 0.5) * 0.35,
        );
        state.maxLife[i] = 1.4 + Math.random() * 1.6;
      }

      const v = state.velocities[i];
      const t = age;

      // Curl turbulence on X/Z so the plume writhes instead of rising straight.
      const curl = Math.sin(t * 3.1 + i) * 0.16;
      const curlZ = Math.cos(t * 2.4 + i * 0.7) * 0.16;

      pos.setXYZ(
        i,
        v.x * t + curl * t,
        v.y * t - 0.42 * t * t,
        v.z * t + curlZ * t,
      );

      // White → yellow → orange → dark red across the particle's life.
      const k = Math.min(1, t / state.maxLife[i]);
      col.setXYZ(
        i,
        1,
        THREE.MathUtils.clamp(1.0 - k * 0.75, 0.12, 1),
        THREE.MathUtils.clamp(0.85 - k * 1.5, 0, 0.85),
      );
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;

    if (light.current) {
      // Hot flash, settling into a flicker.
      const settle = Math.max(0, 1 - elapsed.current / 1.2);
      light.current.intensity =
        2.2 + settle * 14 + Math.sin(elapsed.current * 19) * 0.7;
    }
  });

  return (
    <group position={origin}>
      <points ref={points} geometry={state.geometry} visible={false}>
        <pointsMaterial
          map={texture}
          size={0.45}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          vertexColors
          toneMapped={false}
        />
      </points>
      <pointLight ref={light} color="#ff8a2a" intensity={0} distance={9} />
    </group>
  );
}

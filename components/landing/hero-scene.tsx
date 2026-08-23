"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * The landing hero: a detonator core with five wires fanning out of it.
 *
 * Decorative, and deliberately stateless — it never touches a game. Its job is
 * to say what the show is before anyone has read a word: five wires, one of
 * them is the wrong one, and somebody is about to cut.
 *
 * Everything here loops off `clock.elapsedTime`. No timers, no counters, no
 * state — so nothing drifts, nothing double-fires after a hot reload, and the
 * scene is correct at whatever frame it is first rendered on.
 *
 * Built from the same parts as the studio set (sagging tube wires, brass,
 * exposed copper at a break) so the front door and the show look related. Kept
 * cheaper than the set: no shadows, no post-processing, and the wires fade into
 * fog rather than being lit all the way out.
 */

/** The set's five colours, minus the panel's row ordering. */
const WIRES = [
  { color: "#d92b2b", azimuth: -0.62, lift: 0.95, reach: 4.2, sag: 0.55 },
  { color: "#e8b62c", azimuth: 0.34, lift: 1.25, reach: 3.6, sag: 0.42 },
  { color: "#3d7fd9", azimuth: 2.05, lift: 0.62, reach: 4.6, sag: 0.78 },
  { color: "#4fa83d", azimuth: 3.42, lift: 1.05, reach: 3.9, sag: 0.5 },
  { color: "#e8e2d6", azimuth: 4.6, lift: 0.42, reach: 4.4, sag: 0.88 },
] as const;

/** Seconds a wire holds the spotlight before the cut moves along to the next. */
const CUT_CYCLE = 3.6;

const CORE_RADIUS = 0.46;

export function HeroScene({ still = false }: { still?: boolean }) {
  const rig = useRef<THREE.Group>(null);
  const lean = useRef({ x: 0, y: 0 });

  /**
   * Pointer parallax rather than orbit controls.
   *
   * A landing page should not have a camera the visitor can lose. This leans
   * the whole assembly a few degrees toward the cursor and always drifts back,
   * so it feels alive without ever ending up somewhere broken.
   */
  useFrame((state, delta) => {
    if (!rig.current) return;

    const p = state.pointer;
    lean.current.x += (p.x - lean.current.x) * Math.min(1, delta * 2.2);
    lean.current.y += (p.y - lean.current.y) * Math.min(1, delta * 2.2);

    const spin = still ? 0.4 : state.clock.elapsedTime * 0.085;
    rig.current.rotation.y = spin + lean.current.x * 0.28;
    rig.current.rotation.x = -lean.current.y * 0.16;
    rig.current.position.y = still
      ? 0
      : Math.sin(state.clock.elapsedTime * 0.5) * 0.055;

    /**
     * Slide out of the way of the copy on a wide screen.
     *
     * The page puts its text in a left column, so on anything landscape the
     * assembly moves right to sit beside it rather than behind it. Driven off
     * the actual viewport aspect instead of a CSS breakpoint, because what
     * matters here is where the object lands in frame.
     */
    const targetX = state.viewport.aspect > 1.15 ? 1.35 : 0;
    rig.current.position.x +=
      (targetX - rig.current.position.x) * Math.min(1, delta * 3);
  });

  return (
    <>
      {/* The wires run out past the frame; fog is what stops them ending in a
          visible stub. */}
      <fogExp2 attach="fog" args={["#0a0806", 0.19]} />

      <Lighting still={still} />

      <group ref={rig} position={[0, -0.1, 0]}>
        <Core still={still} />
        {WIRES.map((wire, i) => (
          <Wire key={wire.color} {...wire} index={i} still={still} />
        ))}
      </group>

      <Motes still={still} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The core                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Brass shell, dark cage, hot filament.
 *
 * Three nested pieces turning at different rates, which is what stops a
 * symmetrical object from reading as a stock primitive. The filament breathes on
 * a slow sine — the one thing on the page that looks powered.
 */
function Core({ still }: { still: boolean }) {
  const shell = useRef<THREE.Mesh>(null);
  const cage = useRef<THREE.Mesh>(null);
  const filament = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.PointLight>(null);

  useFrame((state) => {
    const t = still ? 1.2 : state.clock.elapsedTime;
    const breath = 0.5 + Math.sin(t * 1.6) * 0.5;

    if (shell.current) shell.current.rotation.y = t * 0.16;
    if (cage.current) {
      cage.current.rotation.y = -t * 0.24;
      cage.current.rotation.x = t * 0.1;
    }
    if (ring.current) ring.current.rotation.z = t * 0.34;

    if (filament.current) {
      const mat = filament.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 + breath * 0.4;
      filament.current.scale.setScalar(1 + breath * 0.09);
    }
    if (glow.current) glow.current.intensity = 1.5 + breath * 2.6;
  });

  return (
    <group>
      {/* Brass shell — faceted, so the key light breaks across it. */}
      <mesh ref={shell}>
        <icosahedronGeometry args={[CORE_RADIUS, 1]} />
        <meshStandardMaterial
          color="#9a7742"
          emissive="#c9973f"
          emissiveIntensity={0.14}
          roughness={0.31}
          metalness={0.95}
          flatShading
        />
      </mesh>

      {/* Dark cage over the shell, counter-turning. */}
      <mesh ref={cage}>
        <icosahedronGeometry args={[CORE_RADIUS + 0.11, 1]} />
        <meshStandardMaterial
          color="#1a1512"
          roughness={0.62}
          metalness={0.5}
          wireframe
        />
      </mesh>

      {/* The filament inside. Additive, so it reads as light and not plastic. */}
      <mesh ref={filament}>
        <icosahedronGeometry args={[CORE_RADIUS - 0.13, 2]} />
        <meshBasicMaterial
          color="#ffd98a"
          transparent
          opacity={0.7}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* A tilted brass ring, purely for the silhouette. */}
      <mesh ref={ring} rotation={[Math.PI * 0.42, 0.2, 0]}>
        <torusGeometry args={[CORE_RADIUS + 0.34, 0.017, 8, 64]} />
        <meshStandardMaterial
          color="#c9973f"
          emissive="#c9973f"
          emissiveIntensity={0.35}
          roughness={0.3}
          metalness={0.9}
        />
      </mesh>

      <pointLight ref={glow} color="#ffcf87" intensity={2.4} distance={7} />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* One wire                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A wire, and the cut that travels around the five of them.
 *
 * Same construction as the set's panel: one whole tube swapped for two stubs
 * partway through the cut, because a tube cannot grow a gap in its middle. The
 * stubs recoil and the break shows copper.
 *
 * The wire re-joins at the end of its slot. On the set that would be a lie; on
 * a landing page the loop is the point — it is the question the show asks,
 * asked five times a cycle.
 */
function Wire({
  color,
  azimuth,
  lift,
  reach,
  sag,
  index,
  still,
}: {
  color: string;
  azimuth: number;
  lift: number;
  reach: number;
  sag: number;
  index: number;
  still: boolean;
}) {
  const { whole, inner, outer, breakAt } = useMemo(
    () => buildWire({ azimuth, lift, reach, sag }),
    [azimuth, lift, reach, sag],
  );

  const wholeRef = useRef<THREE.Mesh>(null);
  const innerRef = useRef<THREE.Group>(null);
  const outerRef = useRef<THREE.Group>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const flashRef = useRef<THREE.PointLight>(null);
  const sparksRef = useRef<THREE.Points>(null);
  const cut = useRef(0);

  /** Sparks: fixed velocities, positions rewritten from the cut's own phase. */
  const sparks = useMemo(() => {
    const count = 26;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 0.6 + Math.random() * 1.7;
      velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      // Biased upward — sparks fly off a snip, they do not rain down.
      velocities[i * 3 + 1] = Math.abs(Math.cos(phi)) * speed * 1.3;
      velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("velocity", new THREE.BufferAttribute(velocities, 3));
    return geo;
  }, []);

  useFrame((state, delta) => {
    const elapsed = still ? 0 : state.clock.elapsedTime;

    // Whose turn it is, and how far through that turn we are.
    const slot = Math.floor(elapsed / CUT_CYCLE) % WIRES.length;
    const phase = (elapsed % CUT_CYCLE) / CUT_CYCLE;
    const mine = slot === index && !still;

    const target = mine ? cutEnvelope(phase) : 0;
    cut.current += (target - cut.current) * Math.min(1, delta * 9);
    const c = cut.current;

    if (wholeRef.current) wholeRef.current.visible = c < 0.3;
    if (innerRef.current) innerRef.current.visible = c >= 0.3;
    if (outerRef.current) outerRef.current.visible = c >= 0.3;

    // The severed ends pull apart and droop.
    const recoil = THREE.MathUtils.smoothstep(c, 0.3, 1);
    if (innerRef.current) {
      innerRef.current.position.y = -recoil * 0.06;
      innerRef.current.rotation.z = recoil * 0.06;
    }
    if (outerRef.current) {
      outerRef.current.position.y = -recoil * 0.16;
      outerRef.current.rotation.z = -recoil * 0.1;
    }

    if (flashRef.current) {
      flashRef.current.intensity = mine && c > 0.05 && c < 0.9 ? c * 5.5 : 0;
    }

    /**
     * A charge running inward along the wire.
     *
     * Outer end to the core, staggered per wire so the five never pulse in
     * lockstep. Hidden once its own wire is properly parted — a charge crossing
     * the gap would undo the whole gag.
     */
    if (pulseRef.current) {
      const travel = (elapsed * 0.26 + index * 0.21) % 1;
      const visible = c < 0.34;
      pulseRef.current.visible = visible;
      if (visible) {
        pulseRef.current.position.copy(whole.getPointAt(1 - travel));
        pulseRef.current.scale.setScalar(
          0.4 + Math.sin(travel * Math.PI) * 0.85,
        );
      }
    }

    if (sparksRef.current) {
      const visible = mine && c > 0.25 && phase < 0.62;
      sparksRef.current.visible = visible;
      if (visible) {
        const pos = sparks.attributes.position as THREE.BufferAttribute;
        const vel = sparks.attributes.velocity as THREE.BufferAttribute;
        const age = THREE.MathUtils.clamp((phase - 0.14) / 0.45, 0, 1);
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(
            i,
            vel.getX(i) * age * 0.5,
            vel.getY(i) * age * 0.5 - age * age * 0.75,
            vel.getZ(i) * age * 0.5,
          );
        }
        pos.needsUpdate = true;
        (sparksRef.current.material as THREE.PointsMaterial).opacity = 1 - age;
      }
    }
  });

  return (
    <group>
      <mesh ref={wholeRef}>
        <tubeGeometry args={[whole, 60, 0.028, 8, false]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.22}
          roughness={0.42}
        />
      </mesh>

      <group ref={innerRef} visible={false}>
        <mesh>
          <tubeGeometry args={[inner, 34, 0.028, 8, false]} />
          <meshStandardMaterial color={color} roughness={0.55} />
        </mesh>
        <Copper at={inner.getPointAt(1)} />
      </group>

      <group ref={outerRef} visible={false}>
        <mesh>
          <tubeGeometry args={[outer, 34, 0.028, 8, false]} />
          <meshStandardMaterial color={color} roughness={0.55} />
        </mesh>
        <Copper at={outer.getPointAt(0)} />
      </group>

      {/* The terminal collar where the wire leaves the core. */}
      <mesh position={whole.getPointAt(0)}>
        <sphereGeometry args={[0.052, 12, 12]} />
        <meshStandardMaterial color="#a8a49c" roughness={0.3} metalness={0.95} />
      </mesh>

      <mesh ref={pulseRef}>
        <sphereGeometry args={[0.062, 12, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.85}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      <pointLight
        ref={flashRef}
        position={breakAt}
        color="#fffdf0"
        intensity={0}
        distance={3}
      />

      <points
        ref={sparksRef}
        geometry={sparks}
        position={breakAt}
        visible={false}
      >
        <pointsMaterial
          color="#ffd98a"
          size={0.05}
          transparent
          opacity={1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
    </group>
  );
}

/** Exposed copper at a break. */
function Copper({ at }: { at: THREE.Vector3 }) {
  return (
    <mesh position={at}>
      <sphereGeometry args={[0.03, 10, 10]} />
      <meshStandardMaterial
        color="#c9873f"
        emissive="#c9873f"
        emissiveIntensity={0.5}
        roughness={0.3}
        metalness={1}
      />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Dressing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Halogen key, oxblood kicker, almost no fill.
 *
 * The set's own lighting is deliberately flat office light. This is the
 * opposite — one hot source and a coloured rim, which is how you light a single
 * object on a black stage.
 */
function Lighting({ still }: { still: boolean }) {
  const key = useRef<THREE.DirectionalLight>(null);

  useFrame((state) => {
    if (!key.current || still) return;
    // A barely-there flicker. Halogen under load, not a fault.
    const t = state.clock.elapsedTime;
    key.current.intensity =
      2.5 + Math.sin(t * 11) * 0.05 + Math.sin(t * 3.3) * 0.07;
  });

  return (
    <>
      <ambientLight intensity={0.22} color="#fdf0dc" />
      <directionalLight
        ref={key}
        position={[-4.5, 5.5, 3.5]}
        intensity={2.5}
        color="#fff1d8"
      />
      {/* Oxblood from behind, to lift the wires off the ground. */}
      <pointLight
        position={[3.6, -1.4, -3.2]}
        intensity={5}
        distance={12}
        color="#8c2418"
      />
      <pointLight
        position={[0, 3.4, -2]}
        intensity={2.2}
        distance={10}
        color="#4a6d8c"
      />
    </>
  );
}

/**
 * Dust in the beam.
 *
 * Cheap depth cue — without it the core floats in flat black. Heights come from
 * elapsed time modulo the field height, so it wraps forever instead of draining
 * away after a minute.
 */
function Motes({ still }: { still: boolean }) {
  const ref = useRef<THREE.Points>(null);
  const COUNT = 130;
  const SPAN = 9;

  const { geometry, seeds } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      seeds[i * 3] = (Math.random() - 0.5) * SPAN * 1.5;
      seeds[i * 3 + 1] = Math.random() * SPAN;
      seeds[i * 3 + 2] = (Math.random() - 0.5) * SPAN;
    }
    positions.set(seeds);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return { geometry: geo, seeds };
  }, []);

  useFrame((state) => {
    if (!ref.current || still) return;
    const t = state.clock.elapsedTime;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < COUNT; i++) {
      const drift = (seeds[i * 3 + 1] + t * 0.13) % SPAN;
      pos.setXYZ(
        i,
        seeds[i * 3] + Math.sin(t * 0.32 + i) * 0.13,
        drift - SPAN / 2,
        seeds[i * 3 + 2],
      );
    }
    pos.needsUpdate = true;
  });

  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial
        color="#e8c896"
        size={0.028}
        transparent
        opacity={0.4}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One wire's path, plus the two stubs it becomes when cut.
 *
 * Sampled once into points and then sliced, so the stubs lie exactly on the
 * whole wire's path and the swap at the moment of the cut is invisible.
 */
function buildWire({
  azimuth,
  lift,
  reach,
  sag,
}: {
  azimuth: number;
  lift: number;
  reach: number;
  sag: number;
}) {
  const dir = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const points: THREE.Vector3[] = [];
  const STEPS = 26;

  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const radius = CORE_RADIUS + t * reach;
    // Rises out of the core, then falls away under its own weight.
    const y = lift * Math.sin(t * Math.PI * 0.8) - sag * t * t;
    // A lazy S, so no two wires read as the same arc from any angle.
    const twist = Math.sin(t * Math.PI) * 0.42;

    points.push(
      dir.clone().multiplyScalar(radius).addScaledVector(side, twist).setY(y),
    );
  }

  // Break a third of the way out — clear of the core, well inside the fog.
  const mid = Math.round(STEPS * 0.36);
  const breakAt = points[mid].clone();
  const GAP = 0.055;

  /** Pull a stub back from the break, so the two ends never visually touch. */
  const shrink = (pts: THREE.Vector3[], fromEnd: boolean) => {
    const copy = pts.map((p) => p.clone());
    const tip = fromEnd ? copy.length - 1 : 0;
    const next = fromEnd ? copy.length - 2 : 1;
    const back = copy[tip]
      .clone()
      .sub(copy[next])
      .normalize()
      .multiplyScalar(-GAP);
    copy[tip].add(back);
    return copy;
  };

  return {
    whole: new THREE.CatmullRomCurve3(points),
    inner: new THREE.CatmullRomCurve3(shrink(points.slice(0, mid + 1), true)),
    outer: new THREE.CatmullRomCurve3(shrink(points.slice(mid), false)),
    breakAt,
  };
}

/**
 * The cut, as an envelope over one wire's slot in the cycle.
 *
 * Snap open, hold, ease shut — the fast attack is what makes it read as a snip
 * rather than a stretch.
 */
function cutEnvelope(phase: number): number {
  if (phase < 0.1) return 0;
  if (phase < 0.26) return THREE.MathUtils.smoothstep(phase, 0.1, 0.26);
  if (phase < 0.6) return 1;
  if (phase < 0.86) return 1 - THREE.MathUtils.smoothstep(phase, 0.6, 0.86);
  return 0;
}

"use client";

import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { HeroScene } from "./hero-scene";

/**
 * The landing hero's WebGL wrapper.
 *
 * Split from the scene so the page can pull it in with `ssr: false` — three.js
 * is by far the heaviest thing on the front door, and none of it is needed to
 * render the room code or the button that matters.
 *
 * Cheaper than the projector's canvas on purpose: no shadows, lower dpr cap.
 * This runs on whatever phone scanned a link, not on the demo laptop.
 */
export default function HeroCanvas() {
  const [still, setStill] = useState(false);

  /**
   * Honour a reduced-motion preference by freezing the scene in a composed
   * pose rather than hiding it. The picture is doing useful work — it says what
   * the show is — and only the movement is the thing being opted out of.
   */
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setStill(query.matches);
    const onChange = () => setStill(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return (
    <Canvas
      dpr={[1, 1.6]}
      frameloop={still ? "demand" : "always"}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.9, 6.4], fov: 42 }}
      // The page paints its own ground; a transparent canvas would show it
      // through, but an opaque clear is one less blend per frame.
      onCreated={({ gl }) => gl.setClearColor("#0a0806")}
    >
      <HeroScene still={still} />
    </Canvas>
  );
}

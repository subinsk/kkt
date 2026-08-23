import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // agora-token is Node-only; keep it out of the client bundle.
  serverExternalPackages: ["agora-token"],

  /**
   * Contestants join over a tunnel, not over localhost.
   *
   * `next dev` blocks cross-origin requests for its own dev assets by default,
   * which means a phone on a trycloudflare hostname is served the HTML but *not*
   * the JavaScript chunks. React then never hydrates, and the join form falls
   * back to a native HTML submit that reloads the page — which looks exactly
   * like a broken button and says nothing about the real cause.
   *
   * Wildcards, so a restarted tunnel with a new subdomain keeps working. The
   * local network entries are for testing on a phone over wifi without a tunnel.
   *
   * Development only — `next build` ignores this.
   */
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "*.ngrok-free.app",
    "*.ngrok.io",
    "*.loca.lt",
    // Private ranges, for a phone on the same wifi.
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
  ],
};

export default nextConfig;

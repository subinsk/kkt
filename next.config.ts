import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // agora-rtc-sdk-ng is browser-only; keep it out of the server bundle.
  serverExternalPackages: ["agora-token"],
};

export default nextConfig;

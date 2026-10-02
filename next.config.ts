import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
    };
    return config;
  },
  // COOP/COEP are intentionally omitted: this app does not require cross-origin isolation,
  // and browsers ignore COOP on non-secure HTTP origins.
};

export default nextConfig;

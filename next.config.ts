import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Optional native integrations are loaded dynamically by API routes. Keep
  // them external so Next does not try to bundle missing optional packages.
  serverExternalPackages: ['@aws-sdk/client-polly', 'nodejs-whisper'],
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

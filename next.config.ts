import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// Версия приложения читается из package.json на этапе сборки и инлайнится в
// клиентский бандл. Это единственный источник правды (см. src/lib/version.ts):
// в исходниках номер версии не хардкодится.
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf8")
) as { version: string };

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
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

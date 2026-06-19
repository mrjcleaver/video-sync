import type { NextConfig } from "next";
import { execSync } from "child_process";

const gitSha = (() => {
  if (process.env.NEXT_PUBLIC_BUILD_SHA) return process.env.NEXT_PUBLIC_BUILD_SHA;
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "unknown"; }
})();

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["*.app.github.dev"],
  // Type-check + lint are run separately (deploy.sh + CI) — Next 15's
  // in-build worker OOMs in our 7.8GB devcontainer once the project crossed
  // ~30 routes. Disabling here doesn't bypass the checks; deploy.sh runs
  // `tsc --noEmit` before docker build and fails fast on type errors.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  env: {
    NEXT_PUBLIC_APP_VERSION: "0.2.0",
    NEXT_PUBLIC_BUILD_SHA: gitSha,
    NEXT_PUBLIC_BUILD_DATE: process.env.NEXT_PUBLIC_BUILD_DATE || new Date().toISOString(),
  },
  webpack(config) {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};

export default nextConfig;

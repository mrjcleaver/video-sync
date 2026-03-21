import type { NextConfig } from "next";
import { execSync } from "child_process";

const gitSha = (() => {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "unknown"; }
})();

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["*.app.github.dev"],
  env: {
    NEXT_PUBLIC_APP_VERSION: "0.2.0",
    NEXT_PUBLIC_BUILD_SHA: gitSha,
    NEXT_PUBLIC_BUILD_DATE: new Date().toISOString(),
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

import type { NextConfig } from "next";

const projectRoot = process.cwd();

const nextConfig: NextConfig = {
  // Suppress React hydration warnings (they're warnings, not errors)
  reactStrictMode: false,

  // Experimental features
  experimental: {
    optimizePackageImports: [],
  },

  // Avoid incorrect workspace-root inference when this app lives inside a larger workspace.
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },

  // Mark pdfkit as external to prevent bundling issues with __dirname
  serverExternalPackages: ["pdfkit"],
};

export default nextConfig;

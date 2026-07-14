const webpack = require('webpack');
const { tier2Headers, tier3Headers } = require('@imajin/config/next-headers');
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/learn",
  env: { NEXT_PUBLIC_BASE_PATH: "/learn" },
  transpilePackages: ['@imajin/auth','@imajin/bus','@imajin/db','@imajin/onboard','@imajin/ui'],
  async headers() {
    return [
      // Tier 2 + Tier 3 on all routes — this app is embedded by the auth hub.
      // Note: frame-ancestors controls who can frame us, not what we can embed
      // outward (the external videoUrl iframe is unaffected by this header).
      { source: '/:path*', headers: [...tier2Headers(), ...tier3Headers()] },
    ];
  },
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: true,
  webpack: (config) => {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, '');
      })
    );
    return config;
  },
};

module.exports = nextConfig;

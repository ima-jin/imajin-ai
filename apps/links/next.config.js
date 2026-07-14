const webpack = require('webpack');
const { tier2Headers, tier3Headers } = require('@imajin/config/next-headers');
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/links",
  env: { NEXT_PUBLIC_BASE_PATH: "/links" },
  transpilePackages: ['@imajin/auth','@imajin/db','@imajin/ui'],
  async headers() {
    return [
      // Tier 2 + Tier 3 on all routes — this app is embedded by the auth hub
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

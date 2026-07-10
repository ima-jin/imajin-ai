const webpack = require('webpack');
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/learn",
  env: { NEXT_PUBLIC_BASE_PATH: "/learn" },
  transpilePackages: ['@imajin/auth','@imajin/bus','@imajin/db','@imajin/onboard','@imajin/ui'],
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

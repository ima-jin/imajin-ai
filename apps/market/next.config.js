const webpack = require('webpack');
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/market",
  env: { NEXT_PUBLIC_BASE_PATH: "/market" },
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/email','@imajin/ui','@imajin/fair'],
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

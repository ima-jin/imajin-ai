const webpack = require('webpack');
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/links",
  env: { NEXT_PUBLIC_BASE_PATH: "/links" },
  transpilePackages: ['@imajin/auth','@imajin/db','@imajin/ui'],
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

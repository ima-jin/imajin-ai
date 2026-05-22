const webpack = require('webpack');
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/events",
  env: { NEXT_PUBLIC_BASE_PATH: "/events" },
  transpilePackages: ['@imajin/auth','@imajin/chat','@imajin/config','@imajin/db','@imajin/email','@imajin/fair','@imajin/onboard','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
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

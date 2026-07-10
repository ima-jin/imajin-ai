const webpack = require('webpack');
/** @type {import('next').NextConfig} */
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/dykil",
  env: { NEXT_PUBLIC_BASE_PATH: "/dykil" },
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/ui'],
  typescript: { ignoreBuildErrors: false },
  webpack: (config) => {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, '');
      })
    );
    return config;
  },
}

module.exports = nextConfig

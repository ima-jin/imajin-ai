/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/fair','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
};

module.exports = nextConfig;

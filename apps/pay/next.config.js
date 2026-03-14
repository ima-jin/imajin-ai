/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable experimental features for workspace packages
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/fair','@imajin/pay','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/dfos','@imajin/email','@imajin/onboard','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  experimental: {
    serverComponentsExternalPackages: ['@metalabel/dfos-protocol'],
  },
};

module.exports = nextConfig;

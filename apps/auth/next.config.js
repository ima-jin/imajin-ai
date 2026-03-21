/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/dfos','@imajin/email','@imajin/onboard','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ['@metalabel/dfos-protocol'],
};

module.exports = nextConfig;

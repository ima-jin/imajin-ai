/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/email','@imajin/trust-graph','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/learn",
  transpilePackages: ['@imajin/auth','@imajin/db','@imajin/onboard','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/coffee",
  env: { NEXT_PUBLIC_BASE_PATH: "/coffee" },
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/email','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

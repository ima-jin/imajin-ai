/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/market",
  env: { NEXT_PUBLIC_BASE_PATH: "/market" },
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/email','@imajin/ui','@imajin/fair'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

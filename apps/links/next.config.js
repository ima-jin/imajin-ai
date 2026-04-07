/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/links",
  transpilePackages: ['@imajin/auth','@imajin/db','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

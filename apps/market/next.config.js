/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/email','@imajin/ui','@imajin/fair'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

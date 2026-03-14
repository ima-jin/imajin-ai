/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/db','@imajin/onboard','@imajin/ui'],
  reactStrictMode: true,
};

module.exports = nextConfig;

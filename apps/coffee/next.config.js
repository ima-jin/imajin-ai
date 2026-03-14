/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/db','@imajin/ui'],
  reactStrictMode: true,
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/ui'],};
  typescript: { ignoreBuildErrors: true },

module.exports = nextConfig;

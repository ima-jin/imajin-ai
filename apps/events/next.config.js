/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/chat','@imajin/config','@imajin/db','@imajin/email','@imajin/fair','@imajin/onboard','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;

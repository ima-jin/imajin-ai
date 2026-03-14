/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/email','@imajin/onboard','@imajin/ui'],
  // Enable edge runtime for API routes if needed
};

module.exports = nextConfig;

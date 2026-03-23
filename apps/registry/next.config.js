/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: 'standalone', // Disabled — breaks catch-all routes with next start
  
  // Transpile workspace packages
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',
  
  // Transpile workspace packages
  transpilePackages: ['@imajin/auth', '@imajin/db'],
};

module.exports = nextConfig;

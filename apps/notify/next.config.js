/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth', '@imajin/config', '@imajin/db', '@imajin/email'],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

module.exports = nextConfig;

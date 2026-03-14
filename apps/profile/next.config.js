/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/llm','@imajin/ui'],
  reactStrictMode: true,
};

module.exports = nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@imajin/db", "@imajin/ui"],
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
};

module.exports = nextConfig;

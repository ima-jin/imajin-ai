/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@imajin/db", "@imajin/ui", "@imajin/fair"],
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
};

module.exports = nextConfig;

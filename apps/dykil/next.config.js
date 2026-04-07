/** @type {import('next').NextConfig} */
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/dykil",
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
}

module.exports = nextConfig

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@imajin/auth','@imajin/config','@imajin/db','@imajin/dfos','@imajin/email','@imajin/onboard','@imajin/ui'],
  typescript: { ignoreBuildErrors: true },
  experimental: {
    serverComponentsExternalPackages: ['@metalabel/dfos-protocol'],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // @metalabel/dfos-protocol uses Node built-ins (net, tls, fs, perf_hooks)
      // via postgres driver. Stub them out for client bundles — DFOS chain
      // operations only run server-side or use browser crypto APIs.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        net: false,
        tls: false,
        fs: false,
        perf_hooks: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;

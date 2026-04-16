/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@imajin/auth',
    '@imajin/chat',
    '@imajin/cid',
    '@imajin/config',
    '@imajin/db',
    '@imajin/dfos',
    '@imajin/email',
    '@imajin/fair',
    '@imajin/llm',
    '@imajin/media',
    '@imajin/notify',
    '@imajin/onboard',
    '@imajin/pay',
    '@imajin/trust-graph',
    '@imajin/ui',
  ],
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'jin.imajin.ai' },
      { protocol: 'https', hostname: 'dev-jin.imajin.ai' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
  experimental: {
    serverComponentsExternalPackages: ['@metalabel/dfos-protocol'],
    serverActions: { bodySizeLimit: '2gb' },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // @metalabel/dfos-protocol uses Node built-ins (net, tls, fs, perf_hooks)
      // via postgres driver. Stub them out for client bundles.
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

const webpack = require('webpack');
const { tier1Headers, tier2Headers, tier3Headers } = require('@imajin/config/next-headers');
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
    '@imajin/vault-core',
  ],
  async headers() {
    return [
      // Tier 3 — baseline hardening on every route
      { source: '/:path*', headers: tier3Headers() },
      // Tier 2 — kernel routes embedded by the auth hub as iframes
      { source: '/pay',          headers: tier2Headers() },
      { source: '/pay/:path*',   headers: tier2Headers() },
      { source: '/media/:path*', headers: tier2Headers() },
      // Tier 1 — credential / auth-sensitive pages: hard deny framing
      { source: '/auth/login',              headers: tier1Headers() },
      { source: '/auth/register',           headers: tier1Headers() },
      { source: '/auth/security',           headers: tier1Headers() },
      { source: '/auth/settings/security',  headers: tier1Headers() },
    ];
  },
  async rewrites() {
    return [
      // Public short URLs → internal route groups
      { source: '/p/:handle', destination: '/profile/p/:handle' },
      { source: '/p/:handle/:path*', destination: '/profile/p/:handle/:path*' },
    ];
  },
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'jin.imajin.ai' },
      { protocol: 'https', hostname: 'dev-jin.imajin.ai' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
  experimental: {
    serverComponentsExternalPackages: [
      '@metalabel/dfos-protocol',
      '@lore-vcs/sdk',
      'koffi',
    ],
    serverActions: { bodySizeLimit: '2gb' },
  },
  webpack: (config, { isServer }) => {
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, '');
      })
    );
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

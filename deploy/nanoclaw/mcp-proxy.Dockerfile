# mcp-proxy sidecar (imajin-ai#1932) — packages/nanoclaw-imajin-channel.
# Build context is the MONOREPO ROOT (not the package directory) so pnpm's
# workspace protocol (`@imajin/auth: workspace:*`) resolves.
FROM node:22-bookworm-slim

WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/auth ./packages/auth
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY packages/db ./packages/db
COPY packages/nanoclaw-imajin-channel ./packages/nanoclaw-imajin-channel

RUN corepack enable && pnpm install --frozen-lockfile --filter @imajin/nanoclaw-imajin-channel...

# No docker.sock access needed here — unlike the main NanoClaw host
# container, this sidecar only proxies HTTP, so it can safely run as the
# image's built-in non-root user.
USER node
EXPOSE 8788
CMD ["pnpm", "--filter", "@imajin/nanoclaw-imajin-channel", "mcp-proxy"]

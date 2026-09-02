# usage-emitter sidecar (imajin-ai#1932) — packages/nanoclaw-imajin-channel.
# Same monorepo-root context as mcp-proxy.Dockerfile, for the same reason.
FROM node:22-bookworm-slim

WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/auth ./packages/auth
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY packages/db ./packages/db
COPY packages/nanoclaw-imajin-channel ./packages/nanoclaw-imajin-channel

RUN corepack enable && pnpm install --frozen-lockfile --filter @imajin/nanoclaw-imajin-channel...

# No docker.sock access needed here — this sidecar only reads a read-only
# mounted volume and POSTs over HTTP, so it can safely run as the image's
# built-in non-root user.
USER node

# Actual invocation loop lives in docker-compose.yml's `command:` (this is a
# periodic job, not a daemon — see the package README).
CMD ["pnpm", "--filter", "@imajin/nanoclaw-imajin-channel", "usage-emitter"]

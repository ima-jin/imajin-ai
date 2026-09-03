# infer-passthrough — packages/openclaw-infer-passthrough (imajin-ai#1932,
# closing the direct-Anthropic-key deviation via imajin-ai#1959/#1961).
#
# This containerizes that package's OWN existing entry point (`start`:
# `tsx src/server.ts`) verbatim — it is not a new proxy, and no source in
# that package is modified here. Build context is the MONOREPO ROOT (not the
# package directory) so pnpm's workspace protocol (`@imajin/auth:
# workspace:*`) resolves, same as this deploy's mcp-proxy.Dockerfile.
FROM node:22-bookworm-slim

WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/auth ./packages/auth
COPY packages/config ./packages/config
COPY packages/logger ./packages/logger
COPY packages/db ./packages/db
COPY packages/openclaw-infer-passthrough ./packages/openclaw-infer-passthrough

RUN corepack enable && pnpm install --frozen-lockfile --filter @imajin/openclaw-infer-passthrough...

USER node
EXPOSE 8787
CMD ["pnpm", "--filter", "@imajin/openclaw-infer-passthrough", "start"]

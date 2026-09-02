# NanoClaw host container for the first hand-built Imajin instance
# (imajin-ai#1932). Builds the upstream NanoClaw HOST process (the Node
# process that spawns per-conversation agent containers — NOT the agent
# container image itself, which NanoClaw builds separately via its own
# container/build.sh) and applies the imajin-chat channel the same way any
# real `/add-<channel>` skill would: copy + one barrel-import line + rebuild.
#
# ASSUMPTION (harvested-checklist item — verify at deploy time, see
# docs/agents/nanoclaw-first-boot.md): NanoClaw ships no root Dockerfile of
# its own (its documented install path is `bash nanoclaw.sh` on a native
# host, managed by systemd/launchd). This Dockerfile is OUR containerization
# of that host process, built the same way `nanoclaw.sh` does
# (pnpm install --frozen-lockfile && pnpm run build && node dist/index.js).
# It requires the host Docker socket mounted at runtime (see
# docker-compose.yml) so it can spawn agent containers itself — the
# docker-outside-of-docker pattern, not docker-in-docker.
FROM node:22-bookworm-slim AS build

ARG NANOCLAW_GIT_REF=main
ARG NANOCLAW_REPO=https://github.com/qwibitai/nanoclaw.git

RUN apt-get update && apt-get install -y --no-install-recommends g++ git make python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin the exact commit/tag the operator verified — never build against a
# moving `main`. Set NANOCLAW_GIT_REF to a commit sha before deploying.
RUN git clone --depth 1 --branch "${NANOCLAW_GIT_REF}" "${NANOCLAW_REPO}" . \
  || (git clone "${NANOCLAW_REPO}" . && git checkout "${NANOCLAW_GIT_REF}")

RUN corepack enable && pnpm install --frozen-lockfile

# Apply the imajin-chat channel — the rendered output of
# `packages/claw-envelope`'s NanoClaw renderer + this repo's
# `packages/nanoclaw-imajin-channel/src/channel-adapter.ts` (and its
# dependencies), staged into `deploy/nanoclaw/rendered/` before `docker build`
# (see the runbook in docs/agents/nanoclaw-first-boot.md).
COPY rendered/nanoclaw-channel/ src/channels/
RUN grep -qxF "import './imajin-chat.js';" src/channels/index.ts \
  || echo "import './imajin-chat.js';" >> src/channels/index.ts
COPY rendered/groups/ groups/

RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
ENV NODE_ENV=production
# Runs as root (reviewed hotspot, not a default we chose lightly): this
# process spawns its own agent containers by talking to the host Docker
# socket (docker-outside-of-docker), and the socket's group ownership is
# host-specific — pinning a non-root UID/GID here would silently break on
# any host whose docker group GID differs. The operator may instead run
# this container with `--group-add "$(stat -c %g /var/run/docker.sock)"`
# and a non-root USER once the host's docker group GID is known; documented
# as a follow-up hardening step in docs/agents/nanoclaw-first-boot.md rather
# than hardcoded here.
CMD ["node", "dist/index.js"]

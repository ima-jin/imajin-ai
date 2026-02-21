# Deployment Guide

## Monorepo Services

This repo contains multiple services in `apps/`:
- `auth` — Identity service (auth.imajin.ai)
- `profile` — User profiles (profile.imajin.ai)  
- `pay` — Payments (pay.imajin.ai)
- `registry` — Node federation (registry.imajin.ai)

## ⚠️ DO NOT deploy via Vercel CLI from subdirectories

Vercel CLI uploads only the directory you deploy from. Monorepo commands like `cd ../..` or workspace dependencies (`workspace:*`) will fail because parent directories don't exist in the deploy.

## ✅ Correct: Configure via Vercel Dashboard

Each service needs its own Vercel project configured via the dashboard:

1. **Add New Project** → Import `ima-jin/imajin-ai`
2. **Root Directory**: Set to `apps/[service]` (e.g., `apps/registry`)
3. **Framework**: Next.js (auto-detect)
4. **Build/Output**: Leave defaults (`pnpm build`, `.next`)
5. **Environment Variables**: Add `DATABASE_URL`

Vercel auto-detects the monorepo and runs `pnpm install` at the repo root before building in the app directory.

## Why This Works

- Vercel's GitHub integration clones the full repo
- It detects `pnpm-workspace.yaml` and runs install at root
- Workspace dependencies (`@imajin/auth: workspace:*`) resolve correctly
- Build runs in the app's directory

## Services Configuration

| Service | Root Directory | Domain |
|---------|---------------|--------|
| auth | `apps/auth` | auth.imajin.ai |
| profile | `apps/profile` | profile.imajin.ai |
| pay | `apps/pay` | pay.imajin.ai |
| registry | `apps/registry` | registry.imajin.ai |

## Standalone Repos

These services are in separate repos and deploy normally:
- `imajin-events` → events.imajin.ai
- `imajin-chat` → chat.imajin.ai
- `imajin-web` → imajin.ai (www)

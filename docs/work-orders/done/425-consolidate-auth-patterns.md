# Work Order 425 — Consolidate Auth Patterns

**Branch:** `feat/425-consolidate-auth`
**Status:** In Progress

## Problem

Four services contain hand-rolled session-validation code that duplicates what
`requireAuth` / `optionalAuth` from `@imajin/auth` already does centrally:

| App | File | Pattern |
|-----|------|---------|
| connections | `app/api/connections/route.ts` | Local `getSession()` calling auth service directly |
| input | `src/app/api/upload/route.ts` | Manual cookie extraction + auth service fetch |
| input | `src/app/api/transcribe/route.ts` | Optional manual cookie extraction + auth service fetch |
| input | `src/app/api/usage/route.ts` | Manual cookie extraction + auth service fetch |
| www | `app/api/bugs/**` | `authenticateRequest()` from local `lib/session-auth.ts` |
| pay | `app/api/balance/withdraw`, `balance/[did]`, `connect/*` | Same `authenticateRequest()` pattern |

Additionally, `@metalabel/dfos-protocol` in `packages/dfos` is pinned to `^0.1.0`
and needs a bump to `0.2.0`.

## Scope

**In scope — migrate these session validation patterns:**
- connections `app/api/connections/route.ts`
- input `src/app/api/{upload,transcribe,usage}/route.ts`
- www `app/api/bugs/**` routes (4 files)
- pay `app/api/{balance/withdraw,balance/[did],connect/status,connect/dashboard,connect/onboard}` (5 files)

**Out of scope — do NOT touch:**
- Service-to-service HTTP calls: attestations, lookup (`/api/lookup/:did`), soft DID creation, logout proxy
- Client-side fetches (EventChat.tsx, client page components)
- The `pay/lib/auth.ts` `validateToken` function (Bearer API-to-API)

## Parts

### Part 1 — Work order (this document)

Define scope and migration plan.

### Part 2 — Migrate connections

Replace the local `getSession()` in `app/api/connections/route.ts` with
`requireAuth` from `@imajin/auth`.
`session.did` → `identity.id` (identity.id IS the DID).

**Commit:** `fix(connections): replace manual getSession with requireAuth`

### Part 3 — Migrate input routes

Replace manual cookie + auth-service fetch in upload, transcribe, and usage
routes:

- `upload`: `requireAuth` (auth required)
- `transcribe`: `optionalAuth` (auth optional, fallback to `'anonymous'`)
- `usage`: `requireAuth` (auth required)

`session.did || session.sub` → `identity.id`.

**Commit:** `fix(input): replace manual session validation with requireAuth/optionalAuth`

### Part 4 — Migrate www + pay

Add `@imajin/auth` workspace dep to `apps/www/package.json`.

Migrate www `app/api/bugs/**` and pay `app/api/balance/withdraw`,
`balance/[did]`, `connect/{status,dashboard,onboard}` to use `requireAuth`.

Update `www/lib/session-auth.ts` to keep only `isAdmin`, updated to accept
`Identity` from `@imajin/auth` (`.id` instead of `.did`, `'established'`
instead of the incorrect `'hard'` tier).

`auth.identity.did` → `identity.id` throughout.

**Commit:** `fix(www,pay): replace authenticateRequest with requireAuth`

### Part 5 — Bump dfos-protocol

In `packages/dfos/package.json`:
```
"@metalabel/dfos-protocol": "^0.1.0"  →  "@metalabel/dfos-protocol": "0.2.0"
```
Run `pnpm install` from monorepo root to update lockfile.

**Commit:** `chore(dfos): bump dfos-protocol to 0.2.0`

## Verification

After all parts, verify builds for the three most-affected services:

```bash
cd apps/connections && npx next build
cd apps/input      && npx next build
cd apps/www        && npx next build
```

All three must compile with zero TypeScript errors.

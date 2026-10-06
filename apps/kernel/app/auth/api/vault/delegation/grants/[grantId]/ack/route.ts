/**
 * Mounts the grant-ack route under `/auth/api/vault/delegation/grants/{grantId}/ack`
 * (#2624) — the path `loadFromVault` (`@imajin/auth`) builds from
 * `AUTH_SERVICE_URL`. The handler lives, unchanged, at
 * `/api/vault/delegation/grants/{grantId}/ack`. Thin re-export only — the
 * handler self-authenticates via `requireAuth`.
 */
export { POST } from '@/app/api/vault/delegation/grants/[grantId]/ack/route';

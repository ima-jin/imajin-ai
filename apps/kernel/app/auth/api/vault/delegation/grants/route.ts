/**
 * Mounts the delegation-grants list route under `/auth/api/vault/delegation/grants`
 * (#2624). `loadFromVault` (`@imajin/auth`) derives every URL from
 * `AUTH_SERVICE_URL` (`http://localhost:<port>/auth`), so it calls this path;
 * the handler itself lives, unchanged, at `/api/vault/delegation/grants`.
 * Thin re-export only — the handler self-authenticates via `requireAuth`.
 */
export { GET } from '@/app/api/vault/delegation/grants/route';

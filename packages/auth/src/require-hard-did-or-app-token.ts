import { createLogger } from '@imajin/logger';
import {
  authenticateSessionOrAppToken,
  type SessionOrTokenAuthOptions,
  type SessionOrTokenAuthResult,
} from './require-session-or-app-token';

const log = createLogger('auth');

/** How long a DID's tier lookup is reused for app-token callers. */
const TIER_CACHE_TTL_MS = 30_000;
const TIER_CACHE_MAX_ENTRIES = 1000;

const tierCache = new Map<string, { tier: string; expiresAt: number }>();

const HARD_DID_REQUIRED = 'This action requires a full identity (hard DID)';

/** Test hook — drops every cached tier lookup. */
export function clearTierCache(): void {
  tierCache.clear();
}

function cacheTier(did: string, tier: string): void {
  if (tierCache.size >= TIER_CACHE_MAX_ENTRIES) {
    const oldest = tierCache.keys().next().value;
    if (oldest !== undefined) tierCache.delete(oldest);
  }
  tierCache.set(did, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
}

/**
 * Look up a DID's tier via the kernel's public `GET /auth/api/identity/:did`.
 * Returns null when the tier cannot be determined (callers fail closed).
 * Only non-soft (hard) tiers are cached: a soft result is never cached, so a
 * buyer who upgrades soft → hard is accepted on their very next request.
 */
async function lookupTier(did: string): Promise<string | null> {
  const cached = tierCache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  const authUrl = process.env.AUTH_SERVICE_URL;
  if (!authUrl) return null;

  try {
    const res = await fetch(`${authUrl}/api/identity/${encodeURIComponent(did)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.tier !== 'string' || !data.tier) return null;
    if (data.tier !== 'soft') cacheTier(did, data.tier);
    return data.tier;
  } catch (err) {
    log.error({ err: String(err) }, '[AUTH] Identity tier lookup failed');
    return null;
  }
}

/**
 * Like `requireSessionOrAppToken`, but additionally rejects soft DIDs
 * (email-only identities) with 403 — the app-token-capable counterpart of
 * `requireHardDID`.
 *
 * - Cookie callers: tier comes from the kernel session, as in `requireHardDID`.
 * - App-token callers: tokens carry no tier claim (a soft DID that upgrades
 *   must not need every token re-minted), so the tier is looked up from the
 *   kernel's public identity endpoint (hard tiers briefly cached, soft never
 *   cached so an upgrade takes effect immediately). If the tier cannot be
 *   determined the call fails closed (503).
 */
export async function requireHardDIDOrAppToken(
  request: Request,
  options: SessionOrTokenAuthOptions
): Promise<SessionOrTokenAuthResult> {
  const result = await authenticateSessionOrAppToken(request, options);
  if ('error' in result) return result;

  const { auth, sessionTier } = result;
  const tier = auth.via === 'cookie' ? sessionTier : await lookupTier(auth.did);

  if (!tier) {
    return { error: 'Unable to verify identity tier', status: 503 };
  }
  if (tier === 'soft') {
    return { error: HARD_DID_REQUIRED, status: 403 };
  }
  return { auth };
}

import { createLogger } from '@imajin/logger';
import { postInternal } from './internal-post';

const log = createLogger('auth');

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** Sane per-request cap the profile service's `/api/resolve` route enforces (#1998) — kept
 *  in sync manually since this package must not import anything from apps/kernel. */
const RESOLVE_BATCH_SIZE = 200;

export interface ResolvedIdentitySummary {
  did: string;
  handle: string | null;
  displayName: string | null;
  /** Present only when the caller is authorized to see it (service scope, or self). */
  email?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Batched DID -> { handle, displayName, email? } resolution via the kernel
 * profile service's `POST /api/resolve` (#1998) — the public replacement for
 * the `auth.credentials -> profile.profiles -> auth.identities` raw-SQL
 * joins this package (and several apps/events routes) used to hand-roll.
 *
 * Authenticates as a trusted backend service via `PROFILE_INTERNAL_API_KEY`
 * (the same internal-key "service scope" convention as
 * `AUTH_INTERNAL_API_KEY` / `MEDIA_INTERNAL_API_KEY`), so it keeps the same
 * level of access this package already had via direct DB reads — the route
 * never discloses more than that to a service-scope caller, and never less.
 *
 * Never throws: an unreachable/misconfigured profile service, or a DID with
 * no profile at all, simply results in that DID being absent from the
 * returned map — matching how the raw-SQL helpers this replaces failed soft
 * (returning `null`) rather than propagating into transactional flows
 * (refunds, ticket emails, ...).
 */
export async function resolveIdentitiesForDids(dids: string[]): Promise<Map<string, ResolvedIdentitySummary>> {
  const result = new Map<string, ResolvedIdentitySummary>();
  const uniqueDids = [...new Set(dids)].filter(Boolean);
  if (uniqueDids.length === 0) return result;

  const profileUrl = process.env.PROFILE_SERVICE_URL;
  if (!profileUrl) return result;
  const internalKey = process.env.PROFILE_INTERNAL_API_KEY;

  for (const batch of chunk(uniqueDids, RESOLVE_BATCH_SIZE)) {
    try {
      const res = await fetch(`${profileUrl}/api/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalKey ? { Authorization: `Bearer ${internalKey}` } : {}),
        },
        body: JSON.stringify({ dids: batch }),
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const entry of (data.results ?? []) as ResolvedIdentitySummary[]) {
        if (entry?.did) result.set(entry.did, entry);
      }
    } catch {
      // Fail soft — the batch just contributes no entries.
    }
  }
  return result;
}

/**
 * Service-to-service call to the kernel's internal
 * `POST /auth/api/credentials/resolve` (#1992/#1983) — replaces the raw
 * `auth.credentials`/`profile.profiles`/`auth.identities` SQL this file used
 * to run directly against the kernel database, the last direct DB reach in
 * the published `@imajin/auth` SDK. Never throws: a transport/auth failure
 * or an unresolved did/email simply resolves to `null`, matching how the
 * raw-SQL helpers this replaces failed soft rather than propagating into
 * transactional flows (refunds, ticket emails, invite accept, ...).
 */
async function resolveCredential(
  field: 'email' | 'did',
  body: Record<string, unknown>,
): Promise<string | null> {
  try {
    const outcome = await postInternal<Record<string, string | null>>('/api/credentials/resolve', body);
    if (!outcome) {
      log.warn({}, 'Credential resolution skipped: AUTH_SERVICE_URL or ATTESTATION_INTERNAL_API_KEY not set');
      return null;
    }
    if (!outcome.ok) {
      log.warn({ status: outcome.status }, 'Credential resolution rejected');
      return null;
    }
    return outcome.data?.[field] ?? null;
  } catch (err) {
    log.error({ err: String(err) }, 'Credential resolution error');
    return null;
  }
}

/**
 * Look up the email credential for a DID.
 * Returns null if no email credential exists (e.g. keypair-only DIDs).
 *
 * Deliberately narrower than {@link resolveEmailForDid}: this resolves
 * `auth.credentials` only, with no `profile.profiles`/`auth.identities`
 * fallback — a "credentials-only" contract the batched `/api/resolve`
 * route (#1998) does not serve (that route always resolves the full
 * 3-tier precedence).
 */
export async function getEmailForDid(did: string): Promise<string | null> {
  return resolveCredential('email', { did });
}

/**
 * Look up the DID that owns a given email credential.
 * Returns null if no identity has registered this email.
 */
export async function getDidForEmail(email: string): Promise<string | null> {
  return resolveCredential('did', { email: normalizeEmail(email), mode: 'credential' });
}

/**
 * Resolve the DID that owns `email`, consulting every column that
 * independently stores "the" email for a DID, in a single agreed-upon
 * precedence order (#1834 structural-review consolidation proposal; #1858)
 * — so every caller (invite-create's mint decision, invite-accept's
 * identity check, ...) agrees on identity resolution by construction
 * instead of hand-rolling its own credentials-only or contactEmail-only
 * query:
 *
 *  1. `auth.credentials(type='email')` — verified login/registration
 *     email, the authoritative source when present.
 *  2. `profile.profiles.contact_email` — the human's preferred contact
 *     email; may exist even when no credentials row does (e.g. a
 *     keypair-registered user who signed up before #1855's backfill).
 *  3. `auth.identities.contact_email` — a contact email backfilled onto
 *     the identity itself (e.g. from Stripe / ticket metadata) with no
 *     profile row at all.
 *
 * Returns null when no identity owns this email under any of the three.
 * The kernel route resolves the same precedence server-side (#1992) — this
 * is a transport change only, not a behavior change.
 */
export async function resolveDidForEmail(email: string): Promise<string | null> {
  return resolveCredential('did', { email: normalizeEmail(email), mode: 'full' });
}

/**
 * Inverse of {@link resolveDidForEmail}: resolve the email address that
 * best represents `did`, using the same precedence order (auth.credentials
 * → profile.profiles.contact_email → auth.identities.contact_email).
 * Returns null when none of the three has an email on file for this DID.
 *
 * Migrated (#1998) to call the profile service's batched `/api/resolve`
 * route instead of querying `auth.credentials` / `profile.profiles` /
 * `auth.identities` directly — the route implements the exact same
 * precedence server-side, so this is a delivery-mechanism change only.
 */
export async function resolveEmailForDid(did: string): Promise<string | null> {
  const resolved = await resolveIdentitiesForDids([did]);
  return resolved.get(did)?.email ?? null;
}

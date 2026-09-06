import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { db, profiles } from '@/src/db';
import { getClient } from '@imajin/db';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/** Sane upper bound on a single batch (#1998) — keeps the `= ANY(...)` queries
 *  and the response payload bounded regardless of caller behavior.
 *  NOT exported: Next.js route files only permit a fixed allowlist of named
 *  exports (HTTP method handlers + a few route-config keys) — any other
 *  export (like this constant previously was) fails the Next.js build. */
const MAX_RESOLVE_DIDS = 200;

interface ResolveEntry {
  did: string;
  handle: string | null;
  displayName: string | null;
  email?: string;
}

type EmailAuth =
  | { mode: 'service' }
  | { mode: 'self'; did: string }
  | { mode: 'none' };

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * Decide whether — and for which DID(s) — this caller may see `email` in the
 * response. Mirrors the two existing ways the rest of the profile/auth
 * surface gates sensitive fields (never wider):
 *
 *  - **service scope**: a trusted backend presents the shared
 *    `PROFILE_INTERNAL_API_KEY` bearer token, the same internal-key
 *    convention as `AUTH_INTERNAL_API_KEY` / `MEDIA_INTERNAL_API_KEY`. This
 *    is the trust level `packages/auth/src/credentials.ts` and the events
 *    guest/sales export routes already had via direct DB access — moving
 *    them onto HTTP must not shrink or widen that.
 *  - **self via session**: a session-authenticated caller may always see
 *    their own email (matches the owner-view branch of
 *    `GET /api/profile/{id}`), but never anyone else's.
 *
 * Anonymous or session-authenticated-as-someone-else callers get `handle`
 * and `displayName` only — same as the unauthenticated GET path today.
 */
async function resolveEmailAuth(request: NextRequest): Promise<EmailAuth> {
  const internalKey = process.env.PROFILE_INTERNAL_API_KEY;
  const authHeader = request.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (
    bearer &&
    internalKey &&
    bearer.length === internalKey.length &&
    timingSafeEqual(Buffer.from(bearer), Buffer.from(internalKey))
  ) {
    return { mode: 'service' };
  }

  try {
    const session = await getSessionFromCookies(request.headers.get('cookie'));
    if (session?.did) return { mode: 'self', did: session.did };
  } catch {
    // Fall through to anonymous — a broken session must not error the request.
  }

  return { mode: 'none' };
}

/** Merge `{ did, value }` rows into `result`, keeping the first (highest-precedence) value seen per DID. */
function mergeEmailRows(rows: { did: string; value: string }[], result: Map<string, string>): void {
  for (const row of rows) {
    if (!result.has(row.did)) result.set(row.did, row.value);
  }
}

/**
 * Batched replacement for `packages/auth/src/credentials.ts`'s
 * `resolveEmailForDid` precedence (#1834/#1858's agreed-upon order), so this
 * route and that helper never drift:
 *  1. `auth.credentials` (type='email') — verified login/registration email.
 *  2. `profile.profiles.contact_email` — legacy plaintext column.
 *  3. `auth.identities.contact_email` — backfilled contact email.
 */
async function resolveEmailsForDids(dids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (dids.length === 0) return result;

  const sql = getClient();
  try {
    mergeEmailRows(
      await sql<{ did: string; value: string }[]>`
        SELECT did, value FROM auth.credentials
        WHERE type = 'email' AND did = ANY(${dids})
      `,
      result,
    );

    const afterCredentials = dids.filter((d) => !result.has(d));
    if (afterCredentials.length > 0) {
      mergeEmailRows(
        await sql<{ did: string; value: string }[]>`
          SELECT did, contact_email AS value FROM profile.profiles
          WHERE did = ANY(${afterCredentials}) AND contact_email IS NOT NULL
        `,
        result,
      );
    }

    const afterProfile = dids.filter((d) => !result.has(d));
    if (afterProfile.length > 0) {
      mergeEmailRows(
        await sql<{ did: string; value: string }[]>`
          SELECT id AS did, contact_email AS value FROM auth.identities
          WHERE id = ANY(${afterProfile}) AND contact_email IS NOT NULL
        `,
        result,
      );
    }
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to resolve emails for batch');
  }
  return result;
}

type ParsedBody = { dids: string[] } | { error: string; status: number };

function parseResolveBody(body: unknown): ParsedBody {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { dids?: unknown }).dids)) {
    return { error: 'dids must be an array of strings', status: 400 };
  }
  const raw = (body as { dids: unknown[] }).dids;
  if (!raw.every((d) => typeof d === 'string' && d.length > 0)) {
    return { error: 'dids must be an array of non-empty strings', status: 400 };
  }
  const dids = [...new Set(raw as string[])];
  if (dids.length > MAX_RESOLVE_DIDS) {
    return { error: `Too many DIDs — max ${MAX_RESOLVE_DIDS} per request`, status: 400 };
  }
  return { dids };
}

/**
 * POST /api/resolve — batched DID -> { handle, displayName, email? } lookup (#1998).
 *
 * Replaces the hand-rolled `auth.credentials -> profile.profiles ->
 * auth.identities` raw-SQL joins that `packages/auth/src/credentials.ts` and
 * several apps/events routes used to write for themselves (kernel-side gap
 * from the #1983 extraction audit). `handle`/`displayName` are returned for
 * any requested DID that has a profile row, with no auth required — the same
 * disclosure level as the unauthenticated `GET /api/profile/{id}` path.
 * `email` is sensitive and is gated per {@link resolveEmailAuth}; DIDs the
 * caller isn't authorized to see the email for simply omit the field rather
 * than erroring the whole batch. Unknown DIDs (no profile row and no visible
 * email) are silently omitted from `results`.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const parsed = parseResolveBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status, headers: cors });
  }
  const { dids } = parsed;
  if (dids.length === 0) {
    return NextResponse.json({ results: [] }, { headers: cors });
  }

  try {
    const profileRows = await db
      .select({ did: profiles.did, handle: profiles.handle, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.did, dids));
    const profileByDid = new Map(profileRows.map((p) => [p.did, p]));

    const emailAuth = await resolveEmailAuth(request);
    let emailByDid = new Map<string, string>();
    if (emailAuth.mode === 'service') {
      emailByDid = await resolveEmailsForDids(dids);
    } else if (emailAuth.mode === 'self') {
      emailByDid = await resolveEmailsForDids(dids.filter((d) => d === emailAuth.did));
    }

    const results: ResolveEntry[] = [];
    for (const did of dids) {
      const profile = profileByDid.get(did);
      const email = emailByDid.get(did);
      if (!profile && email === undefined) continue; // fully unknown DID
      results.push({
        did,
        handle: profile?.handle ?? null,
        displayName: profile?.displayName ?? null,
        ...(email !== undefined ? { email } : {}),
      });
    }

    return NextResponse.json({ results }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to resolve identities');
    return NextResponse.json({ error: 'Failed to resolve identities' }, { status: 500, headers: cors });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db, credentials, identities, profiles } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';

const log = createLogger('kernel');

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * `auth.credentials(type='email')` lookup for `did` — no `profile.profiles`/
 * `auth.identities` fallback. Backs `getEmailForDid` (#1992): a narrower
 * "credentials-only" contract the batched `POST /profile/api/resolve`
 * (#1998) does not serve (that route always resolves the full 3-tier
 * precedence).
 */
async function emailCredentialForDid(did: string): Promise<string | null> {
  const [row] = await db
    .select({ value: credentials.value })
    .from(credentials)
    .where(and(eq(credentials.did, did), eq(credentials.type, 'email')))
    .limit(1);
  return row?.value ?? null;
}

/** Reverse of {@link emailCredentialForDid}: `auth.credentials` only. Backs `getDidForEmail`. */
async function didForEmailCredential(normalizedEmail: string): Promise<string | null> {
  const [row] = await db
    .select({ did: credentials.did })
    .from(credentials)
    .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
    .limit(1);
  return row?.did ?? null;
}

async function didForEmailViaProfile(normalizedEmail: string): Promise<string | null> {
  const [row] = await db
    .select({ did: profiles.did })
    .from(profiles)
    .where(sql`lower(trim(${profiles.contactEmail})) = ${normalizedEmail}`)
    .limit(1);
  return row?.did ?? null;
}

async function didForEmailViaIdentity(normalizedEmail: string): Promise<string | null> {
  const [row] = await db
    .select({ did: identities.id })
    .from(identities)
    .where(sql`lower(trim(${identities.contactEmail})) = ${normalizedEmail}`)
    .limit(1);
  return row?.did ?? null;
}

/**
 * Full 3-tier precedence (#1834 structural-review consolidation; #1858):
 * `auth.credentials` -> `profile.profiles.contact_email` ->
 * `auth.identities.contact_email`. Backs `resolveDidForEmail`.
 */
async function didForEmailFull(normalizedEmail: string): Promise<string | null> {
  const byCredential = await didForEmailCredential(normalizedEmail);
  if (byCredential) return byCredential;

  const byProfile = await didForEmailViaProfile(normalizedEmail);
  if (byProfile) return byProfile;

  return didForEmailViaIdentity(normalizedEmail);
}

type ParsedRequest =
  | { kind: 'email-for-did'; did: string }
  | { kind: 'did-for-email'; email: string; mode: 'credential' | 'full' }
  | { error: string };

function parseBody(body: unknown): ParsedRequest {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Request body must be a JSON object' };
  }
  const { did, email, mode } = body as Record<string, unknown>;
  const hasDid = typeof did === 'string' && did.length > 0;
  const hasEmail = typeof email === 'string' && email.length > 0;

  if (hasDid === hasEmail) {
    return { error: 'Exactly one of did or email is required' };
  }
  if (hasDid) {
    return { kind: 'email-for-did', did: did as string };
  }
  if (mode !== undefined && mode !== 'credential' && mode !== 'full') {
    return { error: 'mode must be "credential" or "full"' };
  }
  return { kind: 'did-for-email', email: email as string, mode: mode === 'credential' ? 'credential' : 'full' };
}

/**
 * POST /auth/api/credentials/resolve — internal credential resolution
 * (#1992/#1983). Replaces the raw SQL that `packages/auth/src/credentials.ts`
 * used to run directly against `auth.credentials`, `profile.profiles`, and
 * `auth.identities` for the two directions the batched
 * `POST /profile/api/resolve` (#1998) does not serve: a "credentials-only"
 * DID<->email lookup (`getEmailForDid`/`getDidForEmail`), and the full
 * 3-tier email->DID precedence (`resolveDidForEmail`).
 *
 * Requires `ATTESTATION_INTERNAL_API_KEY` as Bearer token — same convention
 * as the sibling internal routes (`/api/eligibility/evaluate`,
 * `/api/identity/:did/contact`). No session cookie: the caller acts on its
 * own service identity.
 */
export async function POST(request: NextRequest) {
  const authError = requireInternalApiKey(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    if (parsed.kind === 'email-for-did') {
      const email = await emailCredentialForDid(parsed.did);
      return NextResponse.json({ email });
    }

    const normalized = normalizeEmail(parsed.email);
    const did = parsed.mode === 'credential'
      ? await didForEmailCredential(normalized)
      : await didForEmailFull(normalized);
    return NextResponse.json({ did });
  } catch (error) {
    log.error({ err: String(error) }, 'Credential resolution error');
    return NextResponse.json({ error: 'Failed to resolve credentials' }, { status: 500 });
  }
}

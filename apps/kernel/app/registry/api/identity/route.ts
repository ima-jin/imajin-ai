import { NextResponse } from 'next/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, identityMembers } from '@/src/db';
import { PENDING_OWNER_TRANSFER_KEY } from '@/src/lib/auth/ownership-policy';
import {
  resolveOrMintIdentity,
  isResolveIdentityError,
} from '@/src/lib/registry/identity-alias';

import { identityRepo, mapType } from '@/src/lib/registry/identity-repo';

const log = createLogger('kernel');

/**
 * Parse and coerce the POST /registry/api/identity request body.
 * Cognitive complexity: 7 (≤ 15)
 */
function parseIdentityRequestBody(body: Record<string, unknown>) {
  const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : null;
  const ref = typeof body.ref === 'string' ? body.ref.trim() : null;
  const type = typeof body.type === 'string' ? body.type.trim() : null;
  const optInRef = typeof body.optInRef === 'string' ? body.optInRef.trim() : null;
  const metadata =
    typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};
  return { namespace, ref, type, optInRef, metadata };
}

/**
 * POST /registry/api/identity — lazy get-or-create identity (Issue #1230).
 *
 * Tripian's Journey State Manager calls this per entity (traveler / hotel /
 * restaurant / internal rec-engine) at journey start, relying entirely on our
 * idempotency (no cache on their side). Same partner-scoped `(namespace, ref)`
 * always resolves to the same canonical `did:imajin:` DID; concurrent
 * first-references collapse to one soft DID.
 *
 * The partner namespace is metadata, not a new DID method. The mint is
 * attributed to the acting partner DID (provenance: who referenced it first).
 *
 * Auth: dual-mode (Issue #1464)
 *   - App-service Bearer JWT with `identity:write` scope → app-tier path; actingDid = appDid.
 *   - Session cookie or opaque Bearer token → existing user/session path.
 *
 * Body: { namespace: string, ref: string, type: string, metadata?: object }
 * Response: { did, created, type, metadata }
 */
export async function POST(request: Request) {
  // App-auth path: service / broker token carrying identity:write scope (Issue #1464).
  const appAuthResult = await requireAppAuth(request, { scope: 'identity:write' });
  if ('appAuth' in appAuthResult) {
    // Service tokens carry userDid='' — use the app's own DID as the acting principal
    // so identity.created.issuer records provenance as the calling partner.
    return handleIdentityPost(request, appAuthResult.appAuth.appDid, appAuthResult.appAuth.appDid);
  }

  // If the app token was valid but lacked identity:write, propagate the scope error
  // immediately. Do not fall through to session auth — session auth cannot verify app JWTs
  // and would return a misleading 401 instead of the correct 403.
  if (appAuthResult.status === 403) {
    return NextResponse.json({ error: appAuthResult.error }, { status: 403 });
  }

  // Session/user auth path: session cookie or opaque Bearer token.
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return handleIdentityPost(request, resolveActingDid(auth.identity));
}

async function handleIdentityPost(request: Request, actingDid: string, registeredByAppDid: string | null = null) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { namespace, ref, type, optInRef, metadata } = parseIdentityRequestBody(body);
  if (Object.hasOwn(metadata, PENDING_OWNER_TRANSFER_KEY)) {
    return NextResponse.json({ error: 'Ownership transfer metadata is reserved' }, { status: 400 });
  }

  if (!namespace) return NextResponse.json({ error: 'namespace is required' }, { status: 400 });
  if (!ref) return NextResponse.json({ error: 'ref is required' }, { status: 400 });
  if (!type) return NextResponse.json({ error: 'type is required' }, { status: 400 });
  if (optInRef !== null && optInRef.length === 0) {
    return NextResponse.json({ error: 'optInRef must be a non-empty string when provided' }, { status: 400 });
  }

  const result = await resolveOrMintIdentity(identityRepo(registeredByAppDid), { namespace, ref, type, metadata });

  if (isResolveIdentityError(result)) {
    log.error({ namespace, ref, err: result.error }, 'Identity resolution failed');
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (result.minted) {
    const { scope, subtype } = mapType(type!);
    // Reuse identity.created so downstream reactors behave like other mint paths;
    // intentionally not double-firing the full verification chain per referenced entity.
    publish('identity.created', {
      issuer: actingDid,
      subject: result.did,
      scope: 'auth',
      payload: {
        did: result.did,
        scope,
        subtype,
        tier: 'soft',
        context_id: result.did,
        context_type: 'identity',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err), did: result.did }, '[registry/identity] identity.created publish failed (non-fatal)');
    });
  }

  // Record an agent-role controller grant when the caller supplies an opt-in reference.
  // This authorizes the partner (actingDid) to write consent on the traveler's behalf
  // via X-Acting-For, as long as the grant is live. Idempotent: re-reference with the
  // same optInRef reactivates a previously removed grant rather than inserting a duplicate.
  if (optInRef !== null) {
    await upsertAgentGrant({ travelerDid: result.did, appDid: actingDid, optInRef });
  }

  return NextResponse.json(
    { did: result.did, created: result.created, type, metadata: result.metadata },
    { status: result.created ? 201 : 200 },
  );
}

/**
 * Upsert an `agent`-role entry in identity_members.
 *
 * - If no row exists: insert one.
 * - If a row exists and is NOT removed: idempotent no-op (already live).
 * - If a row exists but IS removed: reactivate it (partner re-presented the opt-in).
 *
 * Authorized solely by the presence of `optInRef` — the opt-in is the
 * authorizing event. We never grant silently without it (#1442).
 */
async function upsertAgentGrant({
  travelerDid,
  appDid,
  optInRef,
}: {
  travelerDid: string;
  appDid: string;
  optInRef: string;
}): Promise<void> {
  const [existing] = await db
    .select({ removedAt: identityMembers.removedAt })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, travelerDid),
        eq(identityMembers.memberDid, appDid),
      )
    )
    .limit(1);

  if (!existing) {
    await db.insert(identityMembers).values({
      identityDid: travelerDid,
      memberDid: appDid,
      role: 'agent',
      addedBy: appDid,
      addedVia: 'agent',
      optInRef,
    });
    return;
  }

  // Already live — nothing to do.
  if (existing.removedAt === null) return;

  // Reactivate a previously revoked grant.
  await db
    .update(identityMembers)
    .set({ removedAt: null, role: 'agent', optInRef, addedBy: appDid, addedVia: 'agent', addedAt: new Date() })
    .where(
      and(
        eq(identityMembers.identityDid, travelerDid),
        eq(identityMembers.memberDid, appDid),
        isNotNull(identityMembers.removedAt),
      )
    );
}

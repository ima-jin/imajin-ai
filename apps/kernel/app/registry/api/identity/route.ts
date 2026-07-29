import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { requireAuth, requireAppAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, identities, identityAliases, identityMembers } from '@/src/db';
import {
  resolveOrMintIdentity,
  isResolveIdentityError,
  type IdentityAliasRepo,
} from '@/src/lib/registry/identity-alias';

const log = createLogger('kernel');

/**
 * Map a partner-supplied entity type onto a canonical identity scope/subtype.
 * Travelers are people (actor); everything else is a business-scoped soft
 * entity. The raw partner type is always preserved in metadata.type.
 */
function mapType(type: string): { scope: string; subtype: string } {
  if (type === 'traveler') return { scope: 'actor', subtype: 'human' };
  return { scope: 'business', subtype: type };
}

/** Drizzle-backed repository enforcing the unique (namespace, ref) constraint. */
const repo: IdentityAliasRepo = {
  async findAlias(namespace, ref) {
    const [row] = await db
      .select({ did: identityAliases.did })
      .from(identityAliases)
      .where(and(eq(identityAliases.namespace, namespace), eq(identityAliases.ref, ref)))
      .limit(1);
    return row?.did ?? null;
  },

  async claimAlias(namespace, ref, did) {
    const claimed = await db
      .insert(identityAliases)
      .values({ namespace, ref, did })
      .onConflictDoNothing({ target: [identityAliases.namespace, identityAliases.ref] })
      .returning({ did: identityAliases.did });
    return claimed.length > 0;
  },

  async createIdentity(did, type, metadata) {
    const { scope, subtype } = mapType(type);
    const name = typeof metadata.name === 'string' ? metadata.name.slice(0, 100) : null;
    const [identity] = await db
      .insert(identities)
      .values({
        id: did,
        scope,
        subtype,
        publicKey: `soft_${nanoid(32)}`, // no keypair; placeholder satisfies NOT NULL UNIQUE
        handle: null,
        name,
        metadata,
      })
      .returning();
    return (identity.metadata as Record<string, unknown> | null) ?? metadata;
  },

  async getIdentityMetadata(did) {
    const [identity] = await db
      .select({ metadata: identities.metadata })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);
    if (!identity) return null;
    return (identity.metadata as Record<string, unknown> | null) ?? {};
  },

  async mergeMetadata(did, incoming) {
    const [identity] = await db
      .select({ metadata: identities.metadata })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);
    const current = (identity?.metadata as Record<string, unknown> | null) ?? {};
    const merged = { ...current, ...incoming };
    const [updated] = await db
      .update(identities)
      .set({ metadata: merged, updatedAt: new Date() })
      .where(eq(identities.id, did))
      .returning({ metadata: identities.metadata });
    return (updated?.metadata as Record<string, unknown> | null) ?? merged;
  },

  mintDid() {
    return `did:imajin:${nanoid(44)}`;
  },
};

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
    return handleIdentityPost(request, appAuthResult.appAuth.appDid);
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

async function handleIdentityPost(request: Request, actingDid: string) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { namespace, ref, type, optInRef, metadata } = parseIdentityRequestBody(body);

  if (!namespace) return NextResponse.json({ error: 'namespace is required' }, { status: 400 });
  if (!ref) return NextResponse.json({ error: 'ref is required' }, { status: 400 });
  if (!type) return NextResponse.json({ error: 'type is required' }, { status: 400 });
  if (optInRef !== null && optInRef.length === 0) {
    return NextResponse.json({ error: 'optInRef must be a non-empty string when provided' }, { status: 400 });
  }

  const result = await resolveOrMintIdentity(repo, { namespace, ref, type, metadata });

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
      optInRef,
    });
    return;
  }

  // Already live — nothing to do.
  if (existing.removedAt === null) return;

  // Reactivate a previously revoked grant.
  await db
    .update(identityMembers)
    .set({ removedAt: null, role: 'agent', optInRef, addedBy: appDid, addedAt: new Date() })
    .where(
      and(
        eq(identityMembers.identityDid, travelerDid),
        eq(identityMembers.memberDid, appDid),
      )
    );
}

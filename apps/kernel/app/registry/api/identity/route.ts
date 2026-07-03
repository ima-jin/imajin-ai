import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, identities, identityAliases } from '@/src/db';
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
 * Body: { namespace: string, ref: string, type: string, metadata?: object }
 * Response: { did, created, type, metadata }
 */
export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const actingDid = resolveActingDid(auth.identity);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : null;
  const ref = typeof body.ref === 'string' ? body.ref.trim() : null;
  const type = typeof body.type === 'string' ? body.type.trim() : null;
  const metadata =
    typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};

  if (!namespace) return NextResponse.json({ error: 'namespace is required' }, { status: 400 });
  if (!ref) return NextResponse.json({ error: 'ref is required' }, { status: 400 });
  if (!type) return NextResponse.json({ error: 'type is required' }, { status: 400 });

  const result = await resolveOrMintIdentity(repo, { namespace, ref, type, metadata });

  if (isResolveIdentityError(result)) {
    log.error({ namespace, ref, err: result.error }, 'Identity resolution failed');
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (result.minted) {
    const { scope, subtype } = mapType(type);
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

  return NextResponse.json(
    { did: result.did, created: result.created, type, metadata: result.metadata },
    { status: result.created ? 201 : 200 },
  );
}

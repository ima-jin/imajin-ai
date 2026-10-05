import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { optionalAuth } from '@imajin/auth';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { AGENT_SCOPE, AGENT_SUBTYPE, listServiceOf } from '@/src/lib/auth/agent-service';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * `serviceOf` for an `actor/agent`, filtered to what THIS caller may see
 * (#2407). The relation names a principal, so it is disclosed only to its
 * parties — the agent itself (its own session DID) and a principal it serves
 * (the session DID, or the group DID under `X-Acting-As`). It is NEVER derived
 * from `X-Acting-For`: an agent borrowing a principal's identity does not
 * thereby see that principal's other agents. Anyone else — anonymous or a
 * third party — gets `undefined`, and the field is omitted from the response.
 */
async function visibleServiceOf(request: NextRequest, agentDid: string): Promise<string[] | undefined> {
  try {
    const caller = await optionalAuth(request);
    if (!caller) return undefined;

    const serviceOf = await listServiceOf(agentDid);
    if (caller.id === agentDid) return serviceOf;

    const principals = new Set([caller.id, caller.actingAs].filter((did): did is string => Boolean(did)));
    const visible = serviceOf.filter((principalDid) => principals.has(principalDid));
    return visible.length > 0 ? visible : undefined;
  } catch (error) {
    // Public resolution (publicKey/scope/subtype) must keep working when the
    // caller-scoped extra fails; fail closed by omitting the field.
    log.error({ err: String(error), agentDid }, 'Identity resolve: serviceOf lookup failed');
    return undefined;
  }
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did
 * Public endpoint — resolve a DID to its public key and metadata.
 * Returns: { did, publicKey, scope, subtype, tier, dfosDid?, serviceOf? }
 *
 * `serviceOf` (#2407, RFC-31 Phase 1) is present only for an `actor/agent` and
 * only for an authenticated party to the relation — see `visibleServiceOf`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    const [identity] = await db
      .select({
        id: identities.id,
        publicKey: identities.publicKey,
        scope: identities.scope,
        subtype: identities.subtype,
        tier: identities.tier,
      })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404, headers: cors }
      );
    }

    const chain = await getChainByImajinDid(decodedDid);
    const isAgent = identity.scope === AGENT_SCOPE && identity.subtype === AGENT_SUBTYPE;
    const serviceOf = isAgent ? await visibleServiceOf(request, identity.id) : undefined;

    return NextResponse.json(
      {
        did: identity.id,
        publicKey: identity.publicKey,
        scope: identity.scope,
        subtype: identity.subtype,
        tier: identity.tier,
        ...(chain ? { dfosDid: chain.dfosDid } : {}),
        ...(serviceOf ? { serviceOf } : {}),
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Identity resolve error');
    return NextResponse.json(
      { error: 'Failed to resolve identity' },
      { status: 500, headers: cors }
    );
  }
}

/** Authentication and reach-only authority, kept separate from the envelope/delivery seam (#2590). */
import { eq } from 'drizzle-orm';
import { db, identities } from '@/src/db';
import { gateTierForIdentityTier, isTierAdmitted } from '@/src/lib/jin/front-door';
import { publicKeyFromDid } from './crypto';
import { resolveExternalDidVerification } from './did-web';
import { introspectGrant } from './grants';
import { findForeignAgentStub, resolveOrMintForeignAgentStub, FOREIGN_AGENT_STUB_SUBTYPE } from './foreign-agent-stub';

export interface ReachRequester {
  publicKey: string;
  tier: unknown;
}

/** A DID claim alone is never authentication; the caller must still verify its transcript signature. */
export async function resolveReachRequester(requesterDid: string, suppliedKey?: string): Promise<ReachRequester | null> {
  const [identity] = await db.select({
    publicKey: identities.publicKey, tier: identities.tier, subtype: identities.subtype, suspendedAt: identities.suspendedAt,
  }).from(identities).where(eq(identities.id, requesterDid)).limit(1);
  if (identity?.suspendedAt || identity?.subtype === FOREIGN_AGENT_STUB_SUBTYPE) return null;
  if (identity && !requesterDid.startsWith('did:web:')) return identity;
  const publicKey = requesterDid.startsWith('did:web:') ? suppliedKey ?? identity?.publicKey : publicKeyFromDid(requesterDid);
  if (!publicKey || !/^[0-9a-f]{64}$/i.test(publicKey)) return null;
  if (requesterDid.startsWith('did:web:')) {
    const verification = await resolveExternalDidVerification(requesterDid, publicKey);
    if (verification.state !== 'verified') return null;
  }
  return { publicKey, tier: identity?.tier ?? 'soft' };
}

/**
 * Explicit per-agent grants outrank class policy, but NEVER a sender block.
 * Missing legacy gate metadata is not tier admission: it still needs a grant.
 */
export async function authorizeReachRequester(params: {
  requesterDid: string; principalDid: string; publicKey: string; metadata: unknown; tier: unknown; purpose: string; field: string;
}): Promise<{ authorized: boolean; grantId?: string; stubDid?: string }> {
  const existing = await findForeignAgentStub(params.requesterDid, params.principalDid, params.publicKey);
  if (existing?.revokedAt) return { authorized: false };
  const grant = await introspectGrant({
    agentDid: params.requesterDid, capability: 'agent:reach',
    targetDid: params.principalDid, delegatorDid: params.principalDid,
  });
  const grantId = grant.authorized ? grant.grantId : undefined;
  const authored = typeof params.metadata === 'object' && params.metadata !== null && 'agentReachGate' in params.metadata;
  const tierAdmitted = authored && gateTierForIdentityTier(params.tier) !== null && isTierAdmitted(params.metadata, params.tier);
  if (!grantId && (!tierAdmitted || params.purpose !== 'agent.reach' || params.field !== 'contact_topics')) return { authorized: false };
  const stub = await resolveOrMintForeignAgentStub(params.requesterDid, params.principalDid, params.publicKey);
  return { authorized: !!stub && !stub.revokedAt, grantId, stubDid: stub?.stubDid };
}

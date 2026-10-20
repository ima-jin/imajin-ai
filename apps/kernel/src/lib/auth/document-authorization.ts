import { requireAuth } from '@imajin/auth';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, attestationSignatures } from '@/src/db';
import { isActiveGroupMember } from './group-membership';

export interface DocumentActor {
  effectiveDid: string;
  actingHumanDid: string;
}

/** Select a principal through the canonical service-scoped act-as gate, never a body DID. */
export async function requireDocumentActor(
  request: Request,
  options: { write?: boolean } = {},
): Promise<DocumentActor | NextResponse> {
  const auth = await requireAuth(request, { service: 'auth', sessionOnly: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const identity = auth.identity;
  if (identity.actingFor || identity.subtype === 'agent') {
    return NextResponse.json({ error: 'Human document authority required' }, { status: 403 });
  }
  if (options.write && identity.actingAs
    && identity.actingAsRole !== 'owner' && identity.actingAsRole !== 'admin') {
    return NextResponse.json({ error: 'Active owner or admin required' }, { status: 403 });
  }
  return { effectiveDid: identity.actingAs ?? identity.id, actingHumanDid: identity.id };
}

/** Parties and active issuer-org members may read; participation never grants org membership. */
export async function canReadDocument(
  attestationId: string,
  issuerDid: string,
  actor: DocumentActor,
): Promise<boolean> {
  if (actor.effectiveDid === issuerDid) return true;
  const [signature] = await db.select({ id: attestationSignatures.id })
    .from(attestationSignatures)
    .where(and(
      eq(attestationSignatures.attestationId, attestationId),
      eq(attestationSignatures.signerDid, actor.effectiveDid),
    )).limit(1);
  return Boolean(signature) || isActiveGroupMember(issuerDid, actor.actingHumanDid);
}

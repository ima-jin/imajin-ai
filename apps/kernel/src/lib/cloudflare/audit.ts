import { and, desc, eq } from 'drizzle-orm';
import { db, attestations } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import type { ZoneAuthority } from './authority';
import { cloudflareZoneDid } from './contract';

export async function auditMutation(
  authority: ZoneAuthority, operation: string, phase: 'intent' | 'success' | 'failure',
  before: unknown, after: unknown, intentId?: string, approvalId?: string,
): Promise<string> {
  const row = await prepareMechanicalAttestation({
    subjectDid: authority.ownerDid,
    type: 'cloudflare.mutation',
    contextId: cloudflareZoneDid(authority.zoneId), contextType: 'cloudflare.zone',
    payload: {
      actorDid: authority.actor.did, onBehalfOf: authority.ownerDid,
      zoneId: authority.zoneId, domain: authority.domain, operation, phase,
      before, after, intentId: intentId ?? null, approvalId: approvalId ?? null,
    },
  });
  await db.insert(attestations).values(row);
  return row.id;
}

export async function mutation<T>(
  authority: ZoneAuthority, operation: string, before: unknown, after: unknown,
  apply: () => Promise<T>, approvalId?: string,
): Promise<T> {
  // This durable signed write is a gate, not a best-effort diagnostic.
  const intent = await auditMutation(authority, operation, 'intent', before, after, undefined, approvalId);
  let result: T;
  try {
    result = await apply();
  } catch {
    await auditMutation(authority, operation, 'failure', before, null, intent, approvalId);
    throw new Error('Cloudflare mutation failed');
  }
  await auditMutation(authority, operation, 'success', before, operation.endsWith('.delete') ? null : result, intent, approvalId);
  return result;
}

export async function history(authority: ZoneAuthority) {
  return db.select({
    id: attestations.id, issuerDid: attestations.issuerDid, subjectDid: attestations.subjectDid,
    type: attestations.type, contextId: attestations.contextId, contextType: attestations.contextType,
    payload: attestations.payload, signature: attestations.signature, cid: attestations.cid, issuedAt: attestations.issuedAt,
  }).from(attestations).where(and(
    eq(attestations.type, 'cloudflare.mutation'),
    eq(attestations.contextId, cloudflareZoneDid(authority.zoneId)),
    eq(attestations.subjectDid, authority.ownerDid),
  )).orderBy(desc(attestations.issuedAt)).limit(100);
}

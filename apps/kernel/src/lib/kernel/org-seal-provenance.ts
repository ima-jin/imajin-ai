import type { NextRequest } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, identities } from '@/src/db';
import { ExternalMcpError } from './external-mcp-policy';
import { authorizeOrgConnectionAdmin } from './org-held-connection-policy';
import { isOrgScope } from './connection-principal-policy';

/** A field name cannot attest which human loaded an org credential. */
export async function resolveOrgSealProvenance(request: NextRequest, ownerDid: string) {
  return db.transaction(async tx => {
    const [owner] = await tx.select({ scope: identities.scope }).from(identities)
      .where(eq(identities.id, ownerDid)).limit(1);
    if (!owner || !isOrgScope(owner.scope)) return undefined;
    const auth = await requireAuth(request, { sessionOnly: true, service: 'connections' });
    if ('error' in auth) throw new ExternalMcpError(auth.status, 'Human organization admin session required');
    const person = auth.identity;
    if (person.actingFor || person.subtype !== 'human' || resolveActingDid(person) !== ownerDid) {
      throw new ExternalMcpError(403, 'Human organization admin session required');
    }
    const [human] = await tx.select({ id: identities.id }).from(identities).where(and(
      eq(identities.id, person.id), eq(identities.scope, 'actor'), eq(identities.subtype, 'human'),
      isNull(identities.suspendedAt),
    )).limit(1);
    if (!human) throw new ExternalMcpError(403, 'Human organization admin session required');
    await authorizeOrgConnectionAdmin(tx, { orgDid: ownerDid, actorDid: person.id });
    return { loadedByDid: person.id, loadedAt: new Date() };
  });
}

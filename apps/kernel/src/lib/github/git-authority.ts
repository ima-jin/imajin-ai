import { and, eq, gt, isNull } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, attestations, delegationGrants, identities } from '@/src/db';
import { APP_TOKEN_DEFAULT_AUDIENCE, verifyAppToken, type AppTokenPayload } from '@/src/lib/auth/jwt';
import { introspectGrant } from '@/src/lib/auth/grants';
import { isLiveAppAuthorization } from '@/src/lib/auth/live-app-authorization';
import { mcpOAuthContext } from '@/src/lib/mcp/agent-binding';
import { getMcpResource } from '@/src/lib/mcp/oauth-config';
import { GITHUB_CONNECTOR_DID } from './constants';

export interface GitAuthority { actorDid: string; ownerDid: string; grantId?: string }
type Caller = { actorDid: string; ownerDid?: string; boundOwner?: string };

async function callingIdentity(request: Request): Promise<Caller | null> {
  const bearer = request.headers.get('authorization');
  if (bearer) return bearerIdentity(request, bearer);
  const auth = await requireAuth(request, { service: 'github', allowMemberActAs: true });
  if ('error' in auth || auth.identity.subtype !== 'human' || auth.identity.actingFor) return null;
  return { actorDid: auth.identity.id, ownerDid: auth.identity.actingAs ?? resolveActingDid(auth.identity) };
}

async function liveAuthorization(payload: AppTokenPayload): Promise<boolean> {
  const [authorization] = await db.select().from(attestations)
    .where(eq(attestations.id, payload.attestationId)).limit(1);
  const scopes = (authorization?.payload as { scopes?: unknown } | undefined)?.scopes;
  return !!authorization && isLiveAppAuthorization(authorization)
    && authorization.type === 'app.authorized'
    && authorization.issuerDid === payload.sub && authorization.subjectDid === payload.azp
    && Array.isArray(scopes) && scopes.includes('github:read');
}

async function bearerIdentity(request: Request, bearer: string): Promise<Caller | null> {
  if (!bearer.startsWith('Bearer ')) return null;
  const payload = await verifyAppToken(bearer.slice(7));
  if (!payload || payload.isServiceToken || !payload.sub || !payload.azp
    || ![APP_TOKEN_DEFAULT_AUDIENCE, getMcpResource()].includes(payload.aud ?? '')
    || !new Set(payload.scope.split(/\s+/)).has('github:read')) return null;
  if (!await liveAuthorization(payload) || request.headers.has('x-acting-as')) return null;
  // OAuth binds an agent subject to a client; legacy PoP tokens authenticate azp.
  // In neither case is a human resource-owner sub the caller of this operation.
  const actorDid = payload.actingFor ? payload.sub : payload.azp;
  const [identity] = await db.select().from(identities).where(and(
    eq(identities.id, actorDid), isNull(identities.suspendedAt),
  )).limit(1);
  if (identity?.subtype !== 'agent') return null;
  if (payload.actingFor) await mcpOAuthContext(payload);
  return { actorDid, boundOwner: payload.actingFor };
}

/** A selector narrows authority; it never creates authority or picks an arbitrary owner. */
export async function gitAuthority(request: Request): Promise<GitAuthority | number> {
  const caller = await callingIdentity(request);
  if (!caller) return 401;
  const selected = request.headers.get('x-acting-for');
  if (caller.ownerDid) {
    if (selected && selected !== caller.ownerDid) return 403;
    return { actorDid: caller.actorDid, ownerDid: caller.ownerDid };
  }
  if (caller.boundOwner && selected && selected !== caller.boundOwner) return 403;
  const rows = await db.select({ ownerDid: delegationGrants.delegatorDid }).from(delegationGrants)
    .where(and(eq(delegationGrants.agentDid, caller.actorDid),
      eq(delegationGrants.status, 'active'), gt(delegationGrants.expiresAt, new Date())));
  const authorized: GitAuthority[] = [];
  for (const ownerDid of new Set(rows.map(row => row.ownerDid))) {
    const grant = await introspectGrant({
      agentDid: caller.actorDid, delegatorDid: ownerDid, capability: 'github:read',
      targetDid: GITHUB_CONNECTOR_DID,
    });
    if (grant.authorized) authorized.push({ actorDid: caller.actorDid, ownerDid, grantId: grant.grantId });
  }
  const selection = selected ?? caller.boundOwner;
  if (authorized.length > 1 && !selected) return 409;
  if (selection) return authorized.find(grant => grant.ownerDid === selection) ?? 403;
  return authorized[0] ?? 403;
}

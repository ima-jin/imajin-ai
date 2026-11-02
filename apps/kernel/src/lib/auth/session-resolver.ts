import { eq, and } from 'drizzle-orm';
import { provideSessionResolver, type SessionData } from '@imajin/auth';
import { db, identities, identityChains, credentials } from '@/src/db';
import { verifySessionToken } from './jwt';

type KernelSessionResult = { data: SessionData } | { error: string };

/** Canonical JWT verification + current identity lookup for both entry paths. */
export async function resolveKernelSession(token: string): Promise<KernelSessionResult> {
  const session = await verifySessionToken(token);
  if (!session) return { error: 'Invalid or expired session' };
  const [identity] = await db.select().from(identities)
    .where(eq(identities.id, session.sub)).limit(1);
  if (!identity) return { error: 'Identity not found' };
  const metadata = identity.metadata as Record<string, unknown> || {};
  const [chain, emailCred] = await Promise.all([
    db.select({ did: identityChains.did }).from(identityChains)
      .where(eq(identityChains.did, session.sub)).limit(1),
    db.select({ value: credentials.value }).from(credentials)
      .where(and(eq(credentials.did, session.sub), eq(credentials.type, 'email'))).limit(1),
  ]);
  return { data: {
    did: session.sub,
    handle: identity.handle || session.handle,
    scope: identity.scope || session.scope,
    subtype: identity.subtype || session.subtype || undefined,
    name: identity.name || session.name,
    email: emailCred[0]?.value ?? null,
    role: typeof metadata.role === 'string' && metadata.role ? metadata.role : 'member',
    tier: identity.tier || 'soft',
    chainVerified: chain.length > 0,
  } };
}

/** Called before Next serves requests, never registered by corpus/broker-agent. */
export function registerKernelSessionResolver(): void {
  provideSessionResolver(async (token) => {
    const result = await resolveKernelSession(token);
    return 'data' in result ? result.data : null;
  });
}

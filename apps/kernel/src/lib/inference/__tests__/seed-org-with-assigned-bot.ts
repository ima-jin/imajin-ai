import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { crypto, generateKeypair, type Identity } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { db, connectors } from '@/src/db';
import { POST as registerIdentity } from '@/app/auth/api/register/route';
import { POST as createGroup } from '@/app/auth/api/groups/route';
import { POST as addController } from '@/app/auth/api/groups/[groupDid]/controllers/route';
import { POST as sealOrgToken } from '@/app/anthropic/api/token/route';
import { POST as sealOrgCard } from '@/app/connections/api/org-held/[provider]/route';
import { POST as grantMember, DELETE as revokeMember } from '@/app/connections/api/org-held/[provider]/grants/route';
import { sealApiKey, anthropicKeySealed } from '@/src/lib/anthropic/connector';
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';

export const orgSealWriters = ['legacy-token-paste', 'token-route-as-org', 'org-held-card'] as const;
export type OrgSealWriter = typeof orgSealWriters[number];
// The real route factory in its pre-provenance configuration reproduces the
// historical writer; no SQL fixture or metadata backfill stands in for sealing.
const legacyTokenRoute = createConnectorTokenRoutes({
  name: 'Anthropic', sealApiKey, keySealed: anthropicKeySealed,
}).POST;

export function seedRequest(path: string, body: unknown, actingAs?: string) {
  return new NextRequest(`https://kernel.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(actingAs ? { 'x-acting-as': actingAs } : {}) },
    body: JSON.stringify(body),
  });
}

async function created(response: Response, writer: string) {
  if (response.status !== 201) throw new Error(`${writer} refused seed: status ${response.status}`);
  return response.json();
}

/** Identity rows come from signed registration, never test-side inserts. */
export async function seedRegisteredActor(subtype: 'human' | 'agent') {
  const keys = generateKeypair();
  const payload = {
    publicKey: keys.publicKey, handle: `seed_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    name: 'Scenario actor', scope: 'actor', subtype,
  };
  const result = await created(await registerIdentity(seedRequest('/auth/api/register', {
    ...payload, signature: crypto.signSync(JSON.stringify(payload), keys.privateKey),
  })), 'identity registration');
  return { did: result.did as string, keys };
}

/**
 * Uses the same group, controller-assignment, and connector writers as the app.
 * legacy-token-paste deliberately exercises the pre-provenance writer; it does
 * not fill missing loader metadata or replace the node self-grant with SQL.
 */
export async function seedOrgWithAssignedBot(options: {
  authenticate: (identity: Identity) => void;
  seal?: OrgSealWriter;
  cardProvider?: 'anthropic' | 'warp';
  assigned?: boolean;
}) {
  const human = await seedRegisteredActor('human');
  const humanIdentity: Identity = { id: human.did, scope: 'actor', subtype: 'human' };
  options.authenticate(humanIdentity);
  const group = await created(await createGroup(seedRequest('/auth/api/groups', {
    scope: 'business', name: 'Artifact scenario', handle: `org_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  })), 'group creation');
  const orgDid = group.did as string;
  const bot = await seedRegisteredActor('agent');
  if (options.assigned !== false) {
    await created(await addController(seedRequest(`/auth/api/groups/${orgDid}/controllers`, {
      did: bot.did, role: 'agent', allowedServices: null,
    }), { params: Promise.resolve({ groupDid: orgDid }) }), 'agent assignment');
  }
  options.authenticate({ ...humanIdentity, actingAs: orgDid, actingAsRole: 'owner' });
  // Generated only in memory. Never return or include this value in diagnostics.
  const credential = randomUUID();
  const provider = options.cardProvider ?? 'anthropic';
  if (options.seal === 'legacy-token-paste') {
    await created(await legacyTokenRoute(seedRequest('/anthropic/api/token', { token: credential }, orgDid)), 'legacy token sealing');
  } else if (options.seal === 'org-held-card') {
    await created(await sealOrgCard(seedRequest(`/connections/api/org-held/${provider}`, { secret: credential }, orgDid),
      { params: Promise.resolve({ provider }) }), 'org card sealing');
  } else {
    await created(await sealOrgToken(seedRequest('/anthropic/api/token', { token: credential }, orgDid)), 'org connector sealing');
  }
  const [connection] = await db.select().from(connectors).where(eq(connectors.ownerDid, orgDid));
  if (!connection?.sealedKeyField) throw new Error('Connector writer did not retain a sealed field');
  return {
    humanDid: human.did, orgDid, botDid: bot.did, field: connection.sealedKeyField,
    credentialHash: createHash('sha256').update(credential).digest('hex'),
  };
}

/** Grant and revoke through the same admin endpoint used by the org card. */
export async function seedMemberGrant(
  seed: { orgDid: string; humanDid: string }, action: 'grant' | 'revoke', provider = 'anthropic',
) {
  const request = new NextRequest(`https://kernel.test/connections/api/org-held/${provider}/grants`, {
    method: action === 'grant' ? 'POST' : 'DELETE',
    headers: { 'content-type': 'application/json', 'x-acting-as': seed.orgDid },
    body: JSON.stringify({ memberDid: seed.humanDid, reason: 'Scenario per-member authorization' }),
  });
  const response = await (action === 'grant' ? grantMember : revokeMember)(request, { params: Promise.resolve({ provider }) });
  if (response.status !== 200) throw new Error(`Member ${action} route refused seed: status ${response.status}`);
  return response.json();
}

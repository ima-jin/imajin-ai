import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { crypto, generateKeypair, type Identity } from '@imajin/auth';
import { POST as registerIdentity } from '@/app/auth/api/register/route';
import { POST as createGroup } from '@/app/auth/api/groups/route';
import { POST as addController } from '@/app/auth/api/groups/[groupDid]/controllers/route';
import { POST as sealOrgToken } from '@/app/anthropic/api/token/route';
import { sealApiKey } from '@/src/lib/anthropic/connector';

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
  seal?: 'legacy-token-paste' | 'authenticated-org-route';
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
  if (options.seal === 'legacy-token-paste') {
    await sealApiKey(orgDid, credential);
  } else {
    await created(await sealOrgToken(seedRequest('/anthropic/api/token', { token: credential }, orgDid)), 'org connector sealing');
  }
  return {
    humanDid: human.did, orgDid, botDid: bot.did, field: `anthropic-api-key:${orgDid}`,
    credentialHash: createHash('sha256').update(credential).digest('hex'),
  };
}

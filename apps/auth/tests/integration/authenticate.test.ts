import { POST } from '@/app/api/register/route';
import { POST as challengePost } from '@/app/api/challenge/route';
import { POST as authenticatePost } from '@/app/api/authenticate/route';
import { createTestIdentity, type TestIdentity } from '../helpers/test-identity';
import { createTestDb } from '../helpers/test-db';
import { post } from '../helpers/test-request';
import { db, challenges } from '@/src/db';

const testDb = createTestDb();

afterEach(async () => {
  await testDb.cleanup();
});

interface RegisteredIdentity {
  did: string;
  identity: TestIdentity;
}

/**
 * Register a fresh identity and return its DID + test identity object.
 */
async function registerIdentity(ip: string, handle?: string): Promise<RegisteredIdentity> {
  const identity = await createTestIdentity({ type: 'human', handle });
  const payload = await identity.registrationPayload();
  const req = post('/api/register', payload, { ip });
  const res = await POST(req);
  const data = await res.json();
  expect(res.status).toBe(201);
  testDb.trackIdentity(data.did);
  return { did: data.did, identity };
}

/**
 * Request a challenge for a given DID.
 */
async function getChallenge(did: string): Promise<{ challengeId: string; challenge: string }> {
  const req = post('/api/challenge', { id: did });
  const res = await challengePost(req);
  expect(res.status).toBe(200);
  const data = await res.json();
  testDb.trackChallenge(data.challengeId);
  return { challengeId: data.challengeId, challenge: data.challenge };
}

describe('POST /api/authenticate', () => {
  it('full flow: register -> challenge -> authenticate returns a token', async () => {
    const { did, identity } = await registerIdentity('10.13.1.1', 'auth_flow1');
    const { challengeId, challenge } = await getChallenge(did);

    const sig = await identity.sign(challenge);
    const req = post('/api/authenticate', { id: did, challengeId, signature: sig });
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(typeof data.token).toBe('string');
    expect(data.token).toMatch(/^imajin_tok_/);
    expect(data.expiresAt).toBeDefined();
    expect(data.identity).toBeDefined();
    expect(data.identity.id).toBe(did);

    testDb.trackToken(data.token);
  });

  it('returns 401 when signature is wrong', async () => {
    const { did, identity } = await registerIdentity('10.13.2.1', 'auth_badsig2');
    const { challengeId } = await getChallenge(did);

    const wrongSig = 'deadbeef'.repeat(16); // 128 hex chars but invalid
    const req = post('/api/authenticate', { id: did, challengeId, signature: wrongSig });
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toMatch(/signature/i);
  });

  it('returns 400 when reusing an already-used challenge', async () => {
    const { did, identity } = await registerIdentity('10.13.3.1', 'auth_reuse3');
    const { challengeId, challenge } = await getChallenge(did);

    const sig = await identity.sign(challenge);

    // First use — should succeed
    const req1 = post('/api/authenticate', { id: did, challengeId, signature: sig });
    const res1 = await authenticatePost(req1);
    const data1 = await res1.json();
    expect(res1.status).toBe(200);
    testDb.trackToken(data1.token);

    // Second use — challenge is now spent
    const req2 = post('/api/authenticate', { id: did, challengeId, signature: sig });
    const res2 = await authenticatePost(req2);
    const data2 = await res2.json();

    expect(res2.status).toBe(400);
    expect(data2.error).toBeDefined();
  });

  it('returns 404 for a non-existent identity', async () => {
    const fakeDid = 'did:imajin:doesnotexist123456789012345678901234';
    const req = post('/api/authenticate', {
      id: fakeDid,
      challengeId: 'ch_fakechallengeid',
      signature: 'deadbeef'.repeat(16),
    });
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toMatch(/identity/i);
  });

  it('returns 400 when required fields are missing', async () => {
    const req = post('/api/authenticate', {});
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('returns 400 for an invalid (non-existent) challengeId', async () => {
    const { did, identity } = await registerIdentity('10.13.6.1', 'auth_badch6');
    const fakeSig = await identity.sign('somechallenge');

    const req = post('/api/authenticate', {
      id: did,
      challengeId: 'ch_totallyinvalid000000000000000000',
      signature: fakeSig,
    });
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeDefined();
  });
});

import { POST } from '@/app/api/register/route';
import { POST as challengePost } from '@/app/api/challenge/route';
import { createTestIdentity } from '../helpers/test-identity';
import { createTestDb } from '../helpers/test-db';
import { post } from '../helpers/test-request';

const testDb = createTestDb();

afterEach(async () => {
  await testDb.cleanup();
});

/**
 * Helper: register an identity and return its DID.
 */
async function registerIdentity(ip: string, handle?: string): Promise<string> {
  const identity = await createTestIdentity({ type: 'human', handle });
  const payload = await identity.registrationPayload();
  const req = post('/api/register', payload, { ip });
  const res = await POST(req);
  const data = await res.json();
  expect(res.status).toBe(201);
  testDb.trackIdentity(data.did);
  return data.did;
}

describe('POST /api/challenge', () => {
  it('returns 200 with challengeId, challenge, and expiresAt for a valid DID', async () => {
    const did = await registerIdentity('10.12.1.1', 'ch_user1');

    const req = post('/api/challenge', { id: did });
    const res = await challengePost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(typeof data.challengeId).toBe('string');
    expect(data.challengeId.length).toBeGreaterThan(0);
    expect(typeof data.challenge).toBe('string');
    expect(data.challenge.length).toBeGreaterThan(0);
    expect(typeof data.expiresAt).toBe('string');

    testDb.trackChallenge(data.challengeId);
  });

  it('returns 404 for a non-existent DID', async () => {
    const fakeDid = 'did:imajin:nonexistentdeadbeefdeadbeefdeadbeef';

    const req = post('/api/challenge', { id: fakeDid });
    const res = await challengePost(req);
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBeDefined();
  });

  it('returns 400 when id is missing', async () => {
    const req = post('/api/challenge', {});
    const res = await challengePost(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('expiresAt is in the future', async () => {
    const did = await registerIdentity('10.12.4.1', 'ch_future4');
    const before = Date.now();

    const req = post('/api/challenge', { id: did });
    const res = await challengePost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    testDb.trackChallenge(data.challengeId);

    const expiresAtMs = new Date(data.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThan(before);
  });
});

import { POST } from '@/app/api/register/route';
import { POST as challengePost } from '@/app/api/challenge/route';
import { POST as authenticatePost } from '@/app/api/authenticate/route';
import { POST as verifyPost } from '@/app/api/verify/route';
import { GET as sessionGet } from '@/app/api/session/route';
import { createTestIdentity, type TestIdentity } from '../helpers/test-identity';
import { createTestDb } from '../helpers/test-db';
import { post, get } from '../helpers/test-request';
import { canonicalize } from '@imajin/auth';
import { db, challenges, identities } from '@/src/db';
import { createSessionToken } from '@/lib/jwt';

const testDb = createTestDb();
const COOKIE_NAME = 'imajin_session';

afterEach(async () => {
  await testDb.cleanup();
});

/**
 * Register a fresh identity and return its DID and test identity.
 */
async function registerIdentity(
  ip: string,
  opts: { handle?: string; type?: 'human' | 'agent' } = {},
): Promise<{ did: string; identity: TestIdentity }> {
  const { handle, type = 'human' } = opts;
  const identity = await createTestIdentity({ type, handle });
  const payload = await identity.registrationPayload();
  const req = post('/api/register', payload, { ip });
  const res = await POST(req);
  const data = await res.json();
  expect(res.status).toBe(201);
  testDb.trackIdentity(data.did);
  return { did: data.did as string, identity };
}

// ---------------------------------------------------------------------------
// Register edge cases
// ---------------------------------------------------------------------------
describe('Register edge cases', () => {
  it('publicKey that is not valid hex returns 401 (bad signature) or 400', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const payload = await identity.registrationPayload();
    const badPayload = { ...payload, publicKey: 'not_hex_at_all!!' };

    const req = post('/api/register', badPayload, { ip: '10.20.1.1' });
    const res = await POST(req);

    expect([400, 401]).toContain(res.status);
  });

  it('publicKey with odd-length hex string returns 400 or 401', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const payload = await identity.registrationPayload();
    // Make the publicKey odd-length by appending one char
    const badPayload = { ...payload, publicKey: payload.publicKey + 'f' };

    const req = post('/api/register', badPayload, { ip: '10.20.2.1' });
    const res = await POST(req);

    expect([400, 401]).toContain(res.status);
  });

  it('handle with special chars like "test@handle" returns 400', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const { publicKey, type } = await identity.registrationPayload();
    const handle = 'test@handle';
    const signature = await identity.sign(JSON.stringify({ publicKey, handle, name: undefined, type }));

    const req = post('/api/register', { publicKey, handle, type, signature }, { ip: '10.20.3.1' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('handle exactly 3 chars is accepted (minimum valid length)', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const { publicKey, type } = await identity.registrationPayload();
    const handle = 'abc';
    const signature = await identity.sign(JSON.stringify({ publicKey, handle, name: undefined, type }));

    const req = post('/api/register', { publicKey, handle, type, signature }, { ip: '10.20.4.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    testDb.trackIdentity(data.did);
  });

  it('handle exactly 30 chars is accepted (maximum valid length)', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const { publicKey, type } = await identity.registrationPayload();
    const handle = 'a'.repeat(30); // 30 lowercase letters
    const signature = await identity.sign(JSON.stringify({ publicKey, handle, name: undefined, type }));

    const req = post('/api/register', { publicKey, handle, type, signature }, { ip: '10.20.5.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    testDb.trackIdentity(data.did);
  });

  it('handle with 31 chars returns 400 (exceeds maximum)', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const { publicKey, type } = await identity.registrationPayload();
    const handle = 'a'.repeat(31); // 31 chars — too long
    const signature = await identity.sign(JSON.stringify({ publicKey, handle, name: undefined, type }));

    const req = post('/api/register', { publicKey, handle, type, signature }, { ip: '10.20.6.1' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Challenge edge cases
// ---------------------------------------------------------------------------
describe('Challenge edge cases', () => {
  it('id that looks like a DID but does not exist returns 404', async () => {
    const fakeDid = 'did:imajin:FakeIdentityThatDoesNotExistInDB';

    const req = post('/api/challenge', { id: fakeDid });
    const res = await challengePost(req);
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Authenticate edge cases
// ---------------------------------------------------------------------------
describe('Authenticate edge cases', () => {
  it('returns 400 for an expired challenge', async () => {
    const { did, identity } = await registerIdentity('10.21.1.1', { handle: 'auth_exp1' });

    // Insert a challenge that is already expired
    const expiredChallengeId = 'ch_test_expired_edge01';
    const pastDate = new Date(Date.now() - 10 * 60 * 1000);
    await db.insert(challenges).values({
      id: expiredChallengeId,
      identityId: did,
      challenge: 'deadbeef'.repeat(8),
      expiresAt: pastDate,
    });
    testDb.trackChallenge(expiredChallengeId);

    const sig = await identity.sign('deadbeef'.repeat(8));
    const req = post('/api/authenticate', { id: did, challengeId: expiredChallengeId, signature: sig });
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('returns 400 when challenge belongs to a different identity', async () => {
    const { did: did1, identity: identity1 } = await registerIdentity('10.21.2.1', { handle: 'auth_wrong_id2a' });
    const { did: did2 } = await registerIdentity('10.21.2.2', { handle: 'auth_wrong_id2b' });

    // Get a challenge for did2
    const chReq = post('/api/challenge', { id: did2 });
    const chRes = await challengePost(chReq);
    expect(chRes.status).toBe(200);
    const chData = await chRes.json();
    testDb.trackChallenge(chData.challengeId);

    // Attempt to authenticate as did1 using did2's challenge
    const sig = await identity1.sign(chData.challenge);
    const req = post('/api/authenticate', { id: did1, challengeId: chData.challengeId, signature: sig });
    const res = await authenticatePost(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Verify edge cases
// ---------------------------------------------------------------------------
describe('Verify edge cases', () => {
  it('returns { valid: false } for a message with a far-future timestamp', async () => {
    const { did, identity } = await registerIdentity('10.22.1.1', { handle: 'verify_future1' });

    // Build message with timestamp 5 minutes in the future
    const futureTimestamp = Date.now() + 5 * 60 * 1000;
    const msgWithoutSig = { from: did, type: 'human' as const, timestamp: futureTimestamp, payload: {} };
    const canonical = canonicalize(msgWithoutSig);
    const signature = await identity.sign(canonical);
    const futureMsg = { ...msgWithoutSig, signature };

    const req = post('/api/verify', { message: futureMsg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session edge cases
// ---------------------------------------------------------------------------
describe('Session edge cases', () => {
  it('returns 401 when JWT sub is a DID not in DB', async () => {
    // Generate an identity but never register it — its DID is unknown to the DB
    const unknownIdentity = await createTestIdentity({ type: 'human' });
    const token = await createSessionToken({
      sub: unknownIdentity.did,
      type: 'human',
      tier: 'preliminary',
    });

    const req = get('/api/session', { cookies: { [COOKIE_NAME]: token } });
    const res = await sessionGet(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBeDefined();
  });
});

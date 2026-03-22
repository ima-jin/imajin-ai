import { POST } from '@/app/api/register/route';
import { POST as verifyPost } from '@/app/api/verify/route';
import { createTestIdentity } from '../helpers/test-identity';
import { createTestDb } from '../helpers/test-db';
import { post } from '../helpers/test-request';
import { sign, canonicalize } from '@imajin/auth';

const testDb = createTestDb();

afterEach(async () => {
  await testDb.cleanup();
});

/**
 * Register a fresh identity and return its DID and test identity.
 */
async function registerIdentity(ip: string, opts: { handle?: string; type?: 'human' | 'agent' } = {}) {
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

describe('POST /api/verify', () => {
  it('returns { valid: true, identity } for a valid signed message', async () => {
    const { did, identity } = await registerIdentity('10.14.1.1', { handle: 'verify_user1' });

    const msg = await sign({ action: 'test' }, identity.privateKey, { id: did, type: 'human' });
    const req = post('/api/verify', { message: msg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(true);
    expect(data.identity).toBeDefined();
    expect(data.identity.id).toBe(did);
  });

  it('returns { valid: false } for a wrong signature', async () => {
    const { did, identity } = await registerIdentity('10.14.2.1', { handle: 'verify_badsig2' });

    const msg = await sign({ action: 'test' }, identity.privateKey, { id: did, type: 'human' });
    const tamperedMsg = { ...msg, signature: 'deadbeef'.repeat(16) };

    const req = post('/api/verify', { message: tamperedMsg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(false);
  });

  it('returns 400 when the message field is missing', async () => {
    const req = post('/api/verify', {});
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('returns { valid: false } for a message with invalid structure (missing fields)', async () => {
    // A message object that is missing required fields (e.g., no signature, no type)
    const badMsg = { from: 'did:imajin:abc', payload: {} };

    const req = post('/api/verify', { message: badMsg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(false);
  });

  it('returns { valid: false } when identity type does not match message type', async () => {
    // Register as 'human' but send message with type 'agent'
    const { did, identity } = await registerIdentity('10.14.5.1', { handle: 'verify_type5', type: 'human' });

    // Build a message that claims to be 'agent' even though the identity is 'human'
    const timestamp = Date.now();
    const msgWithoutSig = { from: did, type: 'agent' as const, timestamp, payload: {} };
    const canonical = canonicalize(msgWithoutSig);
    const signature = await identity.sign(canonical);
    const mismatchedMsg = { ...msgWithoutSig, signature };

    const req = post('/api/verify', { message: mismatchedMsg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(false);
  });

  it('returns { valid: false } for a non-existent DID', async () => {
    // Generate a key pair but never register it
    const identity = await createTestIdentity({ type: 'human' });
    const fakeDid = identity.did; // not in DB

    const msg = await sign({ action: 'test' }, identity.privateKey, { id: fakeDid, type: 'human' });
    const req = post('/api/verify', { message: msg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/identity/i);
  });

  it('returns { valid: false, error: "Message expired" } for a message with old timestamp', async () => {
    const { did, identity } = await registerIdentity('10.14.7.1', { handle: 'verify_expired7' });

    // Build an expired message manually (10 minutes in the past)
    const oldTimestamp = Date.now() - 10 * 60 * 1000;
    const msgWithoutSig = { from: did, type: 'human' as const, timestamp: oldTimestamp, payload: {} };
    const canonical = canonicalize(msgWithoutSig);
    const signature = await identity.sign(canonical);
    const expiredMsg = { ...msgWithoutSig, signature };

    const req = post('/api/verify', { message: expiredMsg });
    const res = await verifyPost(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.valid).toBe(false);
    expect(data.error).toMatch(/expired/i);
  });
});

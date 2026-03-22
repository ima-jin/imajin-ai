import { POST } from '@/app/api/register/route';
import { createTestIdentity } from '../helpers/test-identity';
import { createTestDb } from '../helpers/test-db';
import { post } from '../helpers/test-request';

const testDb = createTestDb();

afterEach(async () => {
  await testDb.cleanup();
});

describe('POST /api/register', () => {
  it('registers a new human identity and returns 201 with created:true', async () => {
    const identity = await createTestIdentity({ type: 'human', handle: 'alice_reg1' });
    const payload = await identity.registrationPayload();

    const req = post('/api/register', payload, { ip: '10.11.1.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.created).toBe(true);
    expect(data.did).toBeDefined();
    expect(typeof data.did).toBe('string');
    expect(data.did).toMatch(/^did:imajin:/);

    testDb.trackIdentity(data.did);
  });

  it('re-registering with the same key returns 200 with created:false', async () => {
    const identity = await createTestIdentity({ type: 'human', handle: 'alice_rereg2' });
    const payload = await identity.registrationPayload();

    const req1 = post('/api/register', payload, { ip: '10.11.2.1' });
    const res1 = await POST(req1);
    const data1 = await res1.json();
    expect(res1.status).toBe(201);
    testDb.trackIdentity(data1.did);

    const req2 = post('/api/register', payload, { ip: '10.11.2.2' });
    const res2 = await POST(req2);
    const data2 = await res2.json();

    expect(res2.status).toBe(200);
    expect(data2.created).toBe(false);
    expect(data2.did).toBe(data1.did);
  });

  it('returns 409 when handle is taken by a different key', async () => {
    const sharedHandle = 'collide_reg3';

    const identity1 = await createTestIdentity({ type: 'human', handle: sharedHandle });
    const payload1 = await identity1.registrationPayload();
    const req1 = post('/api/register', payload1, { ip: '10.11.3.1' });
    const res1 = await POST(req1);
    const data1 = await res1.json();
    expect(res1.status).toBe(201);
    testDb.trackIdentity(data1.did);

    const identity2 = await createTestIdentity({ type: 'human', handle: sharedHandle });
    const payload2 = await identity2.registrationPayload();
    const req2 = post('/api/register', payload2, { ip: '10.11.3.2' });
    const res2 = await POST(req2);
    const data2 = await res2.json();

    expect(res2.status).toBe(409);
    expect(data2.error).toMatch(/handle/i);
  });

  it('returns 400 when publicKey is missing', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const payload = await identity.registrationPayload();
    const { publicKey: _omit, ...rest } = payload as any;

    const req = post('/api/register', rest, { ip: '10.11.4.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/publicKey/i);
  });

  it('returns 400 for an invalid type', async () => {
    const identity = await createTestIdentity({ type: 'human', handle: 'badtype_reg5' });
    const payload = await identity.registrationPayload();
    const badPayload = { ...payload, type: 'superuser' };

    const req = post('/api/register', badPayload, { ip: '10.11.5.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/type/i);
  });

  it('returns 400 for handle that is too short (2 chars)', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    // Build a fresh payload with invalid handle
    const { publicKey, type } = await identity.registrationPayload();
    const handle = 'ab';
    const signature = await identity.sign(JSON.stringify({ publicKey, handle, name: undefined, type }));

    const req = post('/api/register', { publicKey, handle, type, signature }, { ip: '10.11.6.1' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for handle with uppercase letters', async () => {
    const identity = await createTestIdentity({ type: 'human' });
    const { publicKey, type } = await identity.registrationPayload();
    const handle = 'AB_Test';
    const signature = await identity.sign(JSON.stringify({ publicKey, handle, name: undefined, type }));

    const req = post('/api/register', { publicKey, handle, type, signature }, { ip: '10.11.7.1' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 when signature is missing', async () => {
    const identity = await createTestIdentity({ type: 'human', handle: 'nosig_reg8' });
    const payload = await identity.registrationPayload();
    const { signature: _omit, ...rest } = payload as any;

    const req = post('/api/register', rest, { ip: '10.11.8.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/signature/i);
  });

  it('returns 401 when signature is invalid', async () => {
    const identity = await createTestIdentity({ type: 'human', handle: 'badsig_reg9' });
    const payload = await identity.registrationPayload();
    const badPayload = { ...payload, signature: 'deadbeef'.repeat(16) };

    const req = post('/api/register', badPayload, { ip: '10.11.9.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toMatch(/signature/i);
  });

  it('registers a service/agent identity without an invite code', async () => {
    const identity = await createTestIdentity({ type: 'agent', handle: 'svc_agent_reg10' });
    const payload = await identity.registrationPayload();

    const req = post('/api/register', payload, { ip: '10.11.10.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.created).toBe(true);
    expect(data.did).toBeDefined();

    testDb.trackIdentity(data.did);
  });

  it('sets a session cookie on successful registration', async () => {
    const identity = await createTestIdentity({ type: 'human', handle: 'cookie_reg11' });
    const payload = await identity.registrationPayload();

    const req = post('/api/register', payload, { ip: '10.11.11.1' });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(201);
    testDb.trackIdentity(data.did);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/imajin_session=/);
  });
});

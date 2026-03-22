import { POST } from '@/app/api/register/route';
import { GET as sessionGet } from '@/app/api/session/route';
import { createTestIdentity } from '../helpers/test-identity';
import { createTestDb } from '../helpers/test-db';
import { post, get } from '../helpers/test-request';
import { createSessionToken } from '@/lib/jwt';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';

const testDb = createTestDb();
const COOKIE_NAME = 'imajin_session';

afterEach(async () => {
  await testDb.cleanup();
});

/**
 * Register a fresh identity and return its DID plus the session cookie value.
 */
async function registerAndGetSession(
  ip: string,
  handle?: string,
): Promise<{ did: string; sessionToken: string }> {
  const identity = await createTestIdentity({ type: 'human', handle });
  const payload = await identity.registrationPayload();
  const req = post('/api/register', payload, { ip });
  const res = await POST(req);
  expect(res.status).toBe(201);
  const data = await res.json();
  testDb.trackIdentity(data.did);

  const setCookie = res.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/imajin_session=([^;]+)/);
  const sessionToken = tokenMatch?.[1] ?? '';
  expect(sessionToken).not.toBe('');

  return { did: data.did, sessionToken };
}

describe('GET /api/session', () => {
  it('returns 401 when no session cookie is provided', async () => {
    const req = get('/api/session');
    const res = await sessionGet(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBeDefined();
  });

  it('returns 401 for an invalid/garbage token', async () => {
    const req = get('/api/session', { cookies: { [COOKIE_NAME]: 'totallygarbagetoken' } });
    const res = await sessionGet(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBeDefined();
  });

  it('returns session fields { did, type, tier, role } for a valid session', async () => {
    const { did, sessionToken } = await registerAndGetSession('10.15.3.1', 'sess_valid3');

    const req = get('/api/session', { cookies: { [COOKIE_NAME]: sessionToken } });
    const res = await sessionGet(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.did).toBe(did);
    expect(data.type).toBe('human');
    expect(data.tier).toBeDefined();
    expect(data.role).toBeDefined();
  });

  // REGRESSION: tier must come from DB, not the JWT
  it('REGRESSION: tier is read from DB, not from JWT claims', async () => {
    const { did } = await registerAndGetSession('10.15.4.1', 'sess_tier4');

    // Update the DB tier to 'established'
    await db.update(identities).set({ tier: 'established' }).where(eq(identities.id, did));

    // Create a JWT that deliberately carries a different tier ('soft')
    const customToken = await createSessionToken({ sub: did, type: 'human', tier: 'soft' });

    const req = get('/api/session', { cookies: { [COOKIE_NAME]: customToken } });
    const res = await sessionGet(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    // The response tier must come from DB ('established'), NOT the JWT ('soft')
    expect(data.tier).toBe('established');
    expect(data.tier).not.toBe('soft');
  });
});

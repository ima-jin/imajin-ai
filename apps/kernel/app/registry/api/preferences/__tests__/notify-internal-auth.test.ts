import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../[did]/route';
import { POST, PUT } from '../[did]/interests/[scope]/route';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  limit: vi.fn(),
  values: vi.fn(),
  set: vi.fn(),
  orderBy: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.session,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@/src/lib/vault/internal-secret', () => ({
  getInternalSecret: async () => 'fake-vault-internal-key',
}));
vi.mock('@/src/db', () => ({
  didPreferences: { did: 'did' },
  didInterests: { did: 'did', scope: 'scope' },
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit, orderBy: mocks.orderBy }) }) }),
    insert: () => ({ values: mocks.values }),
    update: () => ({ set: mocks.set }),
  },
}));
const did = 'did:imajin:fake-recipient';
function req(body: unknown = {}, token?: string) {
  return new NextRequest('https://kernel.test/registry/api/preferences', {
    method: 'PUT',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}
function params() { return { params: Promise.resolve({ did, scope: 'events' }) }; }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ error: 'Unauthorized', status: 401 });
  mocks.limit.mockResolvedValue([]);
  mocks.orderBy.mockResolvedValue([]);
  mocks.values.mockReturnValue({ returning: async () => [{ did }] });
  mocks.set.mockReturnValue({ where: () => ({ returning: async () => [{ did }] }) });
});

describe('notify registry internal contract', () => {
  it('allows vault-authenticated preference reads without a user session', async () => {
    const response = await GET(req({}, 'fake-vault-internal-key'), params());
    expect(response.status).toBe(200);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it('allows vault-authenticated lazy interest creation respecting autoSubscribe=false', async () => {
    mocks.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ autoSubscribe: false }]);
    const response = await POST(req({ createdByAttestation: 'test.event' }, 'fake-vault-internal-key'), params());
    expect(response.status).toBe(201);
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      marketing: false, email: false, inapp: false, chat: false, createdByAttestation: 'test.event',
    }));
  });
  it('allows only the internal unsubscribe payload and creates no new enabled channels', async () => {
    const response = await PUT(req({ marketing: false, email: false }, 'fake-vault-internal-key'), params());
    expect(response.status).toBe(200);
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      marketing: false, email: false, inapp: false, chat: false,
    }));
  });
  it.each([
    { marketing: true, email: false },
    { marketing: false, email: true },
    { marketing: false, email: false, inapp: true },
    { marketing: false, email: false, chat: false },
    {},
  ])('rejects broader internal preference writes: %j', async (body) => {
    expect((await PUT(req(body, 'fake-vault-internal-key'), params())).status).toBe(403);
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it.each([GET, POST, PUT])('rejects an invalid internal credential without a valid session', async (handler) => {
    expect((await handler(req({}, 'fake-wrong-key'), params())).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
  });
  it.each([GET, POST, PUT])('retains the session DID ownership check', async (handler) => {
    mocks.session.mockResolvedValue({ identity: { id: 'did:imajin:someone-else' } });
    expect((await handler(req(), params())).status).toBe(403);
  });
  it('allows the owner session to retain full preference editing', async () => {
    mocks.session.mockResolvedValue({ identity: { id: did } });
    const response = await PUT(req({ marketing: true, email: true, inapp: true }), params());
    expect(response.status).toBe(200);
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ marketing: true, email: true, inapp: true }));
  });
});

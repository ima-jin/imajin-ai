import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';

const h = vi.hoisted(() => ({
  admin: vi.fn(), collect: vi.fn(), load: vi.fn(), store: vi.fn(),
  export: vi.fn(), reimport: vi.fn(), status: vi.fn(), log: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAdmin: h.admin }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: h.log, info: h.log, warn: h.log }) }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: h.load, sealAndStoreV2: h.store }));
vi.mock('@/src/db', () => ({
  db: { selectDistinct: () => ({ from: () => ({ where: h.collect }) }) },
  vaultDelegationGrants: { field: 'field', status: 'status' },
}));
vi.mock('@/src/lib/vault/rotation-handoff', async (original) => {
  const actual = await original<typeof import('@/src/lib/vault/rotation-handoff')>();
  return { ...actual, exportRotationHandoff: h.export, reimportRotationHandoff: h.reimport, rotationHandoffStatus: h.status };
});
import { GET, POST } from '../route';

const publicKey = Buffer.from(ed25519.getPublicKey(randomBytes(32))).toString('hex');
const request = (body: unknown) => new Request('https://kernel.test/api/vault/rotation-sweep', {
  method: 'POST', body: JSON.stringify(body),
}) as never;
beforeEach(() => {
  vi.clearAllMocks();
  h.admin.mockResolvedValue(true);
  h.collect.mockResolvedValue([{ field: 'API_KEY' }]);
  h.load.mockResolvedValue(randomBytes(32).toString('base64'));
  h.export.mockImplementation(async (_key, collect) => {
    const fields = await collect();
    return { exported: fields.length, newPublicKey: publicKey };
  });
  h.reimport.mockResolvedValue({ resealed: 1 });
  h.status.mockResolvedValue({ pending: true, exported: 1, newPublicKey: publicKey });
});

describe('rotation sweep browser protocol', () => {
  it('refuses non-admin requests before body, storage, or vault access', async () => {
    h.admin.mockResolvedValue(null);
    const body = vi.fn();
    expect((await POST({ json: body } as never)).status).toBe(401);
    expect((await GET()).status).toBe(401);
    expect(body).not.toHaveBeenCalled();
    for (const edge of [h.status, h.export, h.reimport, h.collect, h.load, h.store]) expect(edge).not.toHaveBeenCalled();
  });
  it('returns only public export metadata, never plaintext or field names', async () => {
    const response = await POST(request({ phase: 'export', newPublicKey: publicKey }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ exported: 1, newPublicKey: publicKey });
    expect(h.export.mock.calls[0][0]).toBe(publicKey);
    expect(h.log).not.toHaveBeenCalled();
  });
  it('does not unseal excluded custody fields', async () => {
    h.collect.mockResolvedValue([
      { field: 'internal-secret:app-self:app:credential' },
      { field: 'vault-imported-key:credential' }, { field: 'vault-group-key:group' }, { field: 'API_KEY' },
    ]);
    expect((await POST(request({ phase: 'export', newPublicKey: publicKey }))).status).toBe(200);
    expect(h.load.mock.calls.map(([field]) => field)).toEqual(['API_KEY']);
  });
  it('fails closed on stale active grants, never a short successful export', async () => {
    h.load.mockResolvedValue(undefined);
    expect((await POST(request({ phase: 'export', newPublicKey: publicKey }))).status).toBe(409);
    expect(h.log).not.toHaveBeenCalled();
  });
  it('returns restart recovery status without the sealed blob', async () => {
    const response = await GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ pending: true, exported: 1, newPublicKey: publicKey });
  });
  it('reimports server-held state without accepting fields', async () => {
    const response = await POST(request({ phase: 'reimport' }));
    expect(await response.json()).toEqual({ resealed: 1 });
    expect(h.reimport).toHaveBeenCalledWith(expect.any(Function));
  });
  it('rejects invalid stored field names before unsealing', async () => {
    h.collect.mockResolvedValue([{ field: 'a::b' }]);
    expect((await POST(request({ phase: 'export', newPublicKey: publicKey }))).status).toBe(409);
    expect(h.load).not.toHaveBeenCalled();
  });
  it('readbacks restored fields before completing reimport', async () => {
    const value = randomBytes(32).toString('base64');
    h.load.mockRejectedValueOnce(new Error('old key')).mockResolvedValueOnce(value);
    h.reimport.mockImplementation(async (restore) => { await restore('API_KEY', value); return { resealed: 1 }; });
    expect((await POST(request({ phase: 'reimport' }))).status).toBe(200);
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][0]).toBe('API_KEY');
    if (h.store.mock.calls[0][1] !== value) throw new Error('Restored value did not match');
  });
  it('retains retry state when an owner grant or readback is not ready', async () => {
    const value = randomBytes(32).toString('base64');
    h.load.mockResolvedValue(undefined);
    h.reimport.mockImplementation(async (restore) => { await restore('API_KEY', value); return { resealed: 1 }; });
    expect((await POST(request({ phase: 'reimport' }))).status).toBe(409);
    expect(h.store).toHaveBeenCalledTimes(1);
  });
  it('does not reseal an already restored field on retry', async () => {
    const value = randomBytes(32).toString('base64');
    h.load.mockResolvedValue(value);
    h.reimport.mockImplementation(async (restore) => { await restore('API_KEY', value); return { resealed: 1 }; });
    expect((await POST(request({ phase: 'reimport' }))).status).toBe(200);
    expect(h.store).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { phase: 'other' }, { phase: 'export' },
    { phase: 'export', newPublicKey: 'invalid' }, { phase: 'reimport', unexpected: true }])(
    'rejects malformed or unexpected input', async (body) => {
      expect((await POST(request(body))).status).toBe(400);
      expect(h.export).not.toHaveBeenCalled();
      expect(h.reimport).not.toHaveBeenCalled();
    },
  );
  it('refuses every legacy plaintext transport body without reading its values', async () => {
    for (const phase of ['export', 'reimport']) {
      const response = await POST(request({ phase, fields: [{ field: 'API_KEY', plaintext: randomBytes(32).toString('base64') }] }));
      expect(response.status).toBe(403);
    }
    expect(h.reimport).not.toHaveBeenCalled();
    expect(h.export).not.toHaveBeenCalled();
  });
  it('rejects invalid JSON', async () => {
    expect((await POST({ json: () => Promise.reject(new Error('invalid')) } as never)).status).toBe(400);
  });
  it.each(['export', 'reimport', 'status'])('never returns or logs upstream exception content (%s)', async (phase) => {
    const sentinel = randomBytes(32).toString('base64');
    h.export.mockRejectedValue(new Error(sentinel));
    h.reimport.mockRejectedValue(new Error(sentinel));
    h.status.mockRejectedValue(new Error(sentinel));
    const response = phase === 'status' ? await GET() : await POST(request({ phase, ...(phase === 'export' ? { newPublicKey: publicKey } : {}) }));
    expect(response.status).toBe(409);
    expect((await response.text()).includes(sentinel)).toBe(false);
    expect(h.log).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectLimit, getChain, verifyChain, resolveReach } = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  getChain: vi.fn(),
  verifyChain: vi.fn(),
  resolveReach: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }) },
  identities: { id: 'id' },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('@/src/lib/auth/dfos', () => ({ getChainByImajinDid: getChain }));
vi.mock('@/src/lib/auth/chain-providers', () => ({ verifyChainLog: verifyChain }));
vi.mock('@/src/lib/auth/reach-discovery', () => ({ resolveReachDiscovery: resolveReach }));
vi.mock('@/src/lib/http/node-url', () => ({ nodeUrl: () => 'https://node.example' }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

import { GET, OPTIONS } from '../route';

const DID = 'did:imajin:alice';
const CARD_URL = 'https://node.example/alice/card';

function call(id = DID) {
  return GET(new Request(`https://node.example/.well-known/did-imajin/${encodeURIComponent(id)}`) as never, {
    params: Promise.resolve({ id: encodeURIComponent(id) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ id: DID }]);
  getChain.mockResolvedValue({ log: ['signed-chain'], dfosDid: 'did:dfos:alice', headCid: 'head-cid' });
  verifyChain.mockResolvedValue({ valid: true, publicKeyMultibase: 'z6Mkalice' });
  resolveReach.mockResolvedValue({ url: CARD_URL });
});

describe('well-known DID document reach discovery', () => {
  it.each([DID, 'alice'])('adds AgentReach for an eligible principal resolved by DID: %s', async (id) => {
    const res = await call(id);
    const doc = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/did+json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(resolveReach).toHaveBeenCalledWith(DID);
    expect(verifyChain).toHaveBeenCalledWith(['signed-chain']);
    expect(doc.service).toEqual([
      { id: `${DID}#chain`, type: 'ImajinChain', serviceEndpoint: `https://node.example/auth/api/identity/${encodeURIComponent(DID)}/chain` },
      { id: `${DID}#agent-reach`, type: 'AgentReach', serviceEndpoint: CARD_URL },
    ]);
    expect(doc.verificationMethod[0].publicKeyMultibase).toBe('z6Mkalice');
    expect(doc['imajin:chainHead']).toBe('head-cid');
  });

  it('omits AgentReach when reach discovery is disabled or the principal is ineligible', async () => {
    resolveReach.mockResolvedValue(null);
    const doc = await (await call()).json();
    expect(doc.service.map((service: { type: string }) => service.type)).toEqual(['ImajinChain']);
  });

  it.each([
    [{ valid: false }, 422],
    [{ valid: true, isDeleted: true }, 410],
  ])('does not resolve reach for an invalid or revoked chain: %j', async (result, status) => {
    verifyChain.mockResolvedValue(result);
    expect((await call()).status).toBe(status);
    expect(resolveReach).not.toHaveBeenCalled();
  });

  it('does not resolve reach for an unknown identity', async () => {
    selectLimit.mockResolvedValue([]);
    expect((await call()).status).toBe(404);
    expect(getChain).not.toHaveBeenCalled();
    expect(resolveReach).not.toHaveBeenCalled();
  });

  it('does not resolve reach when no chain exists', async () => {
    getChain.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(resolveReach).not.toHaveBeenCalled();
  });

  it('still rejects a verified result that contains no verification keys', async () => {
    verifyChain.mockResolvedValue({ valid: true });
    expect((await call()).status).toBe(422);
  });

  it('preserves the verified chain-only document when optional discovery fails', async () => {
    resolveReach.mockResolvedValueOnce(null);
    const baseline = await (await call()).json();
    resolveReach.mockRejectedValue(new Error('private discovery database details'));
    const res = await call();
    const doc = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toBe('application/did+json');
    expect(doc).toEqual(baseline);
    expect(doc.service.map((service: { type: string }) => service.type)).toEqual(['ImajinChain']);
    expect(JSON.stringify(doc)).not.toContain('private discovery database details');
  });

  it('preserves public discovery preflight', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
  });
});

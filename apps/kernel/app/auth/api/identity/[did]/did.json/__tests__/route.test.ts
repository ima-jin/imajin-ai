import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getChain, verifyChain, resolveReach } = vi.hoisted(() => ({
  getChain: vi.fn(),
  verifyChain: vi.fn(),
  resolveReach: vi.fn(),
}));

vi.mock('@/src/lib/auth/dfos', () => ({ getChainByImajinDid: getChain }));
vi.mock('@/src/lib/auth/chain-providers', () => ({ verifyChainLog: verifyChain }));
vi.mock('@/src/lib/auth/reach-discovery', () => ({ resolveReachDiscovery: resolveReach }));
vi.mock('@/src/lib/http/node-url', () => ({ nodeUrl: () => 'https://node.example' }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({ 'Access-Control-Allow-Origin': '*' }) }));
vi.mock('@/app/auth/lib/preflight', () => ({ preflight: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

import { GET } from '../route';

const DID = 'did:imajin:alice';
const CARD_URL = 'https://node.example/alice/card';

function call() {
  return GET(new Request(`https://node.example/auth/api/identity/${encodeURIComponent(DID)}/did.json`) as never, {
    params: Promise.resolve({ did: encodeURIComponent(DID) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getChain.mockResolvedValue({ log: ['signed-chain'], dfosDid: 'did:dfos:alice', headCid: 'head-cid' });
  verifyChain.mockResolvedValue({ valid: true, publicKeyMultibase: 'z6Mkalice' });
  resolveReach.mockResolvedValue({ url: CARD_URL });
});

describe('identity DID document reach discovery', () => {
  it('adds AgentReach pointing at the shared resolver card URL', async () => {
    const res = await call();
    const doc = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/did+json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(getChain).toHaveBeenCalledWith(DID);
    expect(verifyChain).toHaveBeenCalledWith(['signed-chain']);
    expect(resolveReach).toHaveBeenCalledWith(DID);
    expect(doc.service).toEqual([
      { id: `${DID}#chain`, type: 'ImajinChain', serviceEndpoint: `https://node.example/auth/api/identity/${encodeURIComponent(DID)}/chain` },
      { id: `${DID}#agent-reach`, type: 'AgentReach', serviceEndpoint: CARD_URL },
    ]);
    expect(doc.verificationMethod[0].publicKeyMultibase).toBe('z6Mkalice');
    expect(doc['imajin:dfosDid']).toBe('did:dfos:alice');
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

  it('does not resolve reach when no chain exists', async () => {
    getChain.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(resolveReach).not.toHaveBeenCalled();
  });

  it('still rejects a verified result that contains no verification keys', async () => {
    verifyChain.mockResolvedValue({ valid: true });
    expect((await call()).status).toBe(422);
  });

  it('does not advertise reach when discovery fails', async () => {
    resolveReach.mockRejectedValue(new Error('discovery unavailable'));
    expect((await call()).status).toBe(500);
  });
});

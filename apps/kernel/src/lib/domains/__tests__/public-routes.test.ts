import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ evidence: vi.fn(), routable: vi.fn() }));
vi.mock('../routing', () => ({
  domainFromHost: (host: string | null) => host?.includes('.') ? host : null,
  publicDomainEvidence: mocks.evidence,
}));
vi.mock('../service', () => {
  class DomainError extends Error {
    code = 'invalid_domain';
    status = 400;
  }
  return {
    DomainError,
    normalizeDomain: (domain: string) => {
      if (!domain.includes('.')) throw new DomainError('Invalid domain');
      return domain.toLowerCase();
    },
    resolveRoutableDomain: mocks.routable,
  };
});
import { GET as wellKnown } from '../../../../app/.well-known/imajin.json/route';
import { GET as domainCheck } from '../../../../app/api/domain-check/route';
beforeEach(() => vi.clearAllMocks());
describe('well-known signed ownership contract', () => {
  it('reports the signed binding for the actual Host rather than a forwarded host', async () => {
    const evidence = { siteOwner: 'did:gbs', appDid: 'did:app', zoneOwner: 'did:imajin', attestation: { signature: 'proof' } };
    mocks.evidence.mockResolvedValue(evidence);
    const response = await wellKnown(new NextRequest('https://gbs.imajin.ai/.well-known/imajin.json', {
      headers: { host: 'gbs.imajin.ai', 'x-forwarded-host': 'attacker.example' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidence);
    expect(mocks.evidence).toHaveBeenCalledWith('gbs.imajin.ai');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('returns no evidence for pending, revoked or grandfathered domains', async () => {
    mocks.evidence.mockResolvedValue(null);
    expect((await wellKnown(new NextRequest('https://gbs.example/.well-known/imajin.json', {
      headers: { host: 'gbs.example' },
    }))).status).toBe(404);
  });
  it('rejects an invalid Host', async () => {
    expect((await wellKnown(new NextRequest('https://gbs.example/.well-known/imajin.json'))).status).toBe(400);
  });
});
describe('Caddy ask contract', () => {
  it.each(['pending', 'revoked', 'unknown'])('refuses %s hosts', async () => {
    mocks.routable.mockResolvedValue(null);
    const response = await domainCheck(new NextRequest('https://kernel.example/api/domain-check?domain=gbs.example'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ allowed: false, verified: false });
  });
  it.each(['verified', 'legacy'])('allows %s routing without conflating legacy with ownership proof', async (status) => {
    mocks.routable.mockResolvedValue({ status });
    const response = await domainCheck(new NextRequest('https://kernel.example/api/domain-check?domain=gbs.example'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true, verified: status === 'verified' });
  });
  it('rejects a missing or malformed domain with the service error code', async () => {
    const response = await domainCheck(new NextRequest('https://kernel.example/api/domain-check'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_domain' });
  });
  it('does not mask infrastructure failures as a verification failure', async () => {
    mocks.routable.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(domainCheck(new NextRequest('https://kernel.example/api/domain-check?domain=gbs.example'))).rejects.toThrow('database unavailable');
  });
});

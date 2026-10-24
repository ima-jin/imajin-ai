import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@/src/lib/domains/normalize';
const state = vi.hoisted(() => ({ credential: vi.fn(), apply: vi.fn(), node: vi.fn() }));
vi.mock('@/src/lib/vault/domain-credential', () => ({ resolveDomainCredential: state.credential }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: state.node }));
vi.mock('../cloudflare', () => ({
  CloudflareDnsProvider: class {
    apply = state.apply;
  },
}));
import { resolveDnsProvider } from '../provider';
import type { DnsProviderConfig, DnsRecord } from '../types';

const config: DnsProviderConfig = { provider: 'cloudflare', zoneId: 'a'.repeat(32) };
const record: DnsRecord = { type: 'TXT', name: '_imajin.example.com', content: 'did:imajin:owner' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected HTTP'); }));
  state.credential.mockResolvedValue('mock-only-credential');
  state.node.mockReturnValue({ senderDid: 'did:imajin:node' });
  state.apply.mockResolvedValue({ mode: 'automatic', status: 'written', records: [record], instructions: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('provider selection and vault boundary', () => {
  it('defaults to manual without any credential lookup or HTTP', async () => {
    const provider = resolveDnsProvider('example.com');
    expect(await provider.apply([record])).toMatchObject({ mode: 'manual', status: 'action-required' });
    expect(state.credential).not.toHaveBeenCalled();
    expect(state.node).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not reuse another zone purpose for the same domain', async () => {
    const secondZone = 'b'.repeat(32);
    await resolveDnsProvider('example.com', config).apply([record]);
    await resolveDnsProvider('example.com', { provider: 'cloudflare', zoneId: secondZone }).apply([record]);
    expect(state.credential).toHaveBeenNthCalledWith(1, 'example.com', 'did:imajin:node', `dns.cloudflare:${config.zoneId}`);
    expect(state.credential).toHaveBeenNthCalledWith(2, 'example.com', 'did:imajin:node', `dns.cloudflare:${secondZone}`);
  });

  it('fails closed if the node identity is unavailable, without a credential lookup', async () => {
    state.node.mockImplementationOnce(() => { throw new Error('node identity unavailable'); });
    await expect(resolveDnsProvider('example.com', config).apply([record])).rejects.toThrow('dns_credential_unavailable');
    expect(state.credential).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
  });

  it('uses the connector zone purpose and fixed node consumer, rechecking authority every operation', async () => {
    const provider = resolveDnsProvider('EXAMPLE.COM.', config);
    await expect(provider.apply([record])).resolves.toMatchObject({ mode: 'automatic' });
    expect(state.credential).toHaveBeenCalledWith('example.com', 'did:imajin:node', `dns.cloudflare:${config.zoneId}`);
    state.credential.mockRejectedValueOnce(new DomainError('domain_not_verified', 'revoked', 403));
    await expect(provider.apply([record])).rejects.toThrow('dns_credential_unavailable');
    expect(state.credential).toHaveBeenCalledTimes(2);
    expect(state.node).toHaveBeenCalledTimes(2);
    expect(state.apply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider)).not.toContain('mock-only-credential');
  });

  it('returns manual instructions if no usable scoped grant exists', async () => {
    state.credential.mockRejectedValue(new DomainError('credential_unavailable', 'No active grant', 403));
    const result = await resolveDnsProvider('example.com', config).apply([record]);
    expect(result).toMatchObject({ mode: 'manual', status: 'action-required', records: [record] });
    expect(state.apply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes vault failures without downgrading infrastructure or ownership errors', async () => {
    state.credential.mockRejectedValue(new Error('sensitive exception detail'));
    const error = await resolveDnsProvider('example.com', config).apply([record]).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: 'dns_credential_unavailable' });
    expect(error).not.toHaveProperty('cause');
    expect(state.apply).not.toHaveBeenCalled();
  });

  it('validates identifiers and records before credential access', async () => {
    expect(() => resolveDnsProvider('example.com', { ...config, zoneId: '../bad' } as DnsProviderConfig))
      .toThrow('invalid_dns_provider');
    expect(() => resolveDnsProvider('example.com', { provider: 'cpanel' } as unknown as DnsProviderConfig))
      .toThrow('invalid_dns_provider');
    await expect(resolveDnsProvider('example.com', config).apply([{ ...record, name: 'other.net' }]))
      .rejects.toThrow('invalid_dns_records');
    expect(state.credential).not.toHaveBeenCalled();
  });
});

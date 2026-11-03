import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const h = vi.hoisted(() => ({ registrations: vi.fn() }));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({ listConnectorRegistrations: h.registrations }));
vi.mock('../brain', () => ({ listBrainConnectors: () => ['anthropic', 'openai'] }));
import { listDiscoveryConnectorMetadata } from '../self-discovery-connectors';

beforeEach(() => vi.resetAllMocks());

describe('non-inference connector metadata', () => {
  it('queries only the signer and lists configured and unconfigured connectors without granting authority', async () => {
    const privateValue = randomUUID();
    h.registrations.mockResolvedValue([
      { provider: 'warp', status: 'active', sealedKeyField: privateValue },
      { provider: 'external-mcp-postman', status: 'revoked', revokedAt: new Date() },
      { provider: 'future-family', status: 'active', sealedKeyField: privateValue },
      { provider: 'org-held-warp', status: 'active' },
      { provider: 'anthropic-billing', status: 'active' },
    ]);
    const rows = await listDiscoveryConnectorMetadata('did:imajin:agent');
    expect(h.registrations).toHaveBeenCalledTimes(1);
    expect(h.registrations).toHaveBeenCalledWith('did:imajin:agent');
    expect(rows.find(row => row.provider === 'warp')).toMatchObject({
      family: 'http', configured: true, authority: null, grantStatus: 'not-evaluated', usable: null,
    });
    expect(rows.find(row => row.provider === 'external-mcp-postman')).toMatchObject({ family: 'mcp', configured: false });
    expect(rows.find(row => row.provider === 'future-family')).toMatchObject({ family: 'http', configured: true });
    expect(rows.find(row => row.provider === 'mcp')).toMatchObject({ family: 'mcp', configured: false });
    expect(rows.some(row => ['org-held-warp', 'anthropic-billing', 'anthropic', 'openai'].includes(row.provider))).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(privateValue);
  });
  it('fails closed on a failed metadata read, not an invented empty state', async () => {
    h.registrations.mockRejectedValue(new Error('Unavailable'));
    await expect(listDiscoveryConnectorMetadata('did:imajin:agent')).rejects.toThrow('Unavailable');
  });
});

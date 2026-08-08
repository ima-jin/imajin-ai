import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockResolveActingDid, mockStoreConfig } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockResolveActingDid: vi.fn(() => 'did:imajin:agrifortress'),
  mockStoreConfig: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: mockResolveActingDid,
}));

vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

vi.mock('@/src/db', () => ({ db: {}, channelLinks: {} }));

vi.mock('@/src/lib/quickbooks/connector', () => ({ storeConfig: mockStoreConfig }));

import { POST } from '../route';

const APP_DID = 'did:imajin:agrifortress';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  mockRequireAuth.mockReset();
  mockRequireAuth.mockResolvedValue({ identity: {} });
  mockResolveActingDid.mockReturnValue(APP_DID);
  mockStoreConfig.mockReset();
  mockStoreConfig.mockResolvedValue(undefined);
});

describe('POST /quickbooks/api/configure — webhookVerifierToken (xprize #35)', () => {
  it('seals a trimmed webhookVerifierToken alongside the base config fields', async () => {
    await POST(makeRequest({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://imajin.test/quickbooks/callback',
      environment: 'production',
      webhookVerifierToken: '  verifier-abc  ',
    }));

    expect(mockStoreConfig).toHaveBeenCalledWith(
      APP_DID,
      expect.objectContaining({ webhookVerifierToken: 'verifier-abc', environment: 'production' }),
    );
  });

  it('omits webhookVerifierToken from the sealed config when not supplied', async () => {
    await POST(makeRequest({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://imajin.test/quickbooks/callback',
    }));

    const [, config] = mockStoreConfig.mock.calls[0];
    expect(config).not.toHaveProperty('webhookVerifierToken');
  });

  it('omits webhookVerifierToken when it is blank', async () => {
    await POST(makeRequest({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://imajin.test/quickbooks/callback',
      webhookVerifierToken: '   ',
    }));

    const [, config] = mockStoreConfig.mock.calls[0];
    expect(config).not.toHaveProperty('webhookVerifierToken');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealMock, loadMock, whereMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStore: sealMock, loadAndUnseal: loadMock }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
}));

import { buildAuthorizeUrl, resolveActiveGrant, readInvoices, exchangeCodeAndStore, vaultField } from '../connector';

const OWNER = 'did:imajin:scott';

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function sealedTokens(overrides: Record<string, unknown> = {}) {
  loadMock.mockResolvedValue(JSON.stringify({
    accessToken: 'at', refreshToken: 'rt', realmId: 'r1', expiresAt: Date.now() + 3_600_000, ...overrides,
  }));
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  loadMock.mockReset();
  whereMock.mockReset();
  vi.stubEnv('QUICKBOOKS_CLIENT_ID', 'cid');
  vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', 'csecret');
  vi.stubEnv('QUICKBOOKS_REDIRECT_URI', 'https://imajin.test/quickbooks/callback');
  vi.stubEnv('QUICKBOOKS_ENVIRONMENT', 'sandbox');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('buildAuthorizeUrl (#1210)', () => {
  it('includes client_id, redirect_uri, scope, and state', () => {
    const url = buildAuthorizeUrl('state123');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=state123');
    expect(url).toContain('scope=com.intuit.quickbooks.accounting');
    expect(url).toContain(encodeURIComponent('https://imajin.test/quickbooks/callback'));
  });
});

describe('resolveActiveGrant (#1210)', () => {
  it('is true when an active row includes the scope', async () => {
    grant(['quickbooks:read']);
    expect(await resolveActiveGrant(OWNER, 'quickbooks:read')).toBe(true);
  });

  it('is false when no active row includes the scope', async () => {
    grant(['other:scope']);
    expect(await resolveActiveGrant(OWNER, 'quickbooks:read')).toBe(false);
  });
});

describe('readInvoices (#1210)', () => {
  it('fails closed with no grant and never calls the API', async () => {
    whereMock.mockResolvedValue([]);
    await expect(readInvoices(OWNER)).rejects.toThrow(/no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no tokens are sealed', async () => {
    grant(['quickbooks:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(readInvoices(OWNER)).rejects.toThrow(/no_tokens/);
  });

  it('returns normalized invoices from the sandbox API', async () => {
    grant(['quickbooks:read']);
    sealedTokens();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ QueryResponse: { Invoice: [{ Id: '1', DocNumber: '1001', TotalAmt: 42, CurrencyRef: { value: 'CAD' }, TxnDate: '2026-07-01', CustomerRef: { name: 'David' } }] } }),
    });

    const invoices = await readInvoices(OWNER, '2026-06-01');

    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ id: '1', customerName: 'David', totalAmount: 42, currency: 'CAD' });
    const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('sandbox-quickbooks.api.intuit.com/v3/company/r1/query');
  });

  it('refreshes an expired access token before reading', async () => {
    grant(['quickbooks:read']);
    sealedTokens({ expiresAt: Date.now() - 1000 });
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ QueryResponse: { Invoice: [] } }) });

    await readInvoices(OWNER);

    expect(sealMock).toHaveBeenCalled();
    const refreshBody = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(refreshBody).toContain('grant_type=refresh_token');
  });
});

describe('exchangeCodeAndStore (#1210)', () => {
  it('exchanges the auth code and seals the token bundle per-DID', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    });

    await exchangeCodeAndStore(OWNER, 'code123', 'realm9');

    expect(sealMock).toHaveBeenCalledTimes(1);
    const [field, blob] = sealMock.mock.calls[0];
    expect(field).toBe(vaultField(OWNER));
    expect(JSON.parse(blob as string)).toMatchObject({ accessToken: 'at', refreshToken: 'rt', realmId: 'realm9' });
    const tokenBody = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(tokenBody).toContain('grant_type=authorization_code');
  });
});

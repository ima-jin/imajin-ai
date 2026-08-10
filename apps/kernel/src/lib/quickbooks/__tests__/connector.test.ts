import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealMock, loadMock, whereMock, upsertRealmIndexMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  whereMock: vi.fn(),
  upsertRealmIndexMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: sealMock, loadAndUnseal: loadMock }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
}));
vi.mock('../realm-index', () => ({ upsertRealmIndex: upsertRealmIndexMock }));

import {
  buildAuthorizeUrl, resolveActiveGrant, listActiveGrantOwners, readInvoices, createInvoice,
  exchangeCodeAndStore, refreshTokens, storeConfig, vaultField, configField,
} from '../connector';

const OWNER = 'did:imajin:scott';
const APP = 'did:imajin:agrifortress';
const CONFIG = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://imajin.test/quickbooks/callback', environment: 'sandbox' as const };
const APP_CONFIG = { clientId: 'app-cid', clientSecret: 'app-csecret', redirectUri: 'https://imajin.test/quickbooks/callback', environment: 'sandbox' as const };

let configResponse: string | undefined;
let appConfigResponse: string | undefined;
let tokensResponse: string | undefined;

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function setConfig(present = true) {
  configResponse = present ? JSON.stringify(CONFIG) : undefined;
}

function setAppConfig(present = true) {
  appConfigResponse = present ? JSON.stringify(APP_CONFIG) : undefined;
}

function sealedTokens(overrides: Record<string, unknown> = {}) {
  tokensResponse = JSON.stringify({
    accessToken: 'at', refreshToken: 'rt', realmId: 'r1', expiresAt: Date.now() + 3_600_000, ...overrides,
  });
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  whereMock.mockReset();
  upsertRealmIndexMock.mockReset();
  upsertRealmIndexMock.mockResolvedValue(undefined);
  configResponse = undefined;
  appConfigResponse = undefined;
  tokensResponse = undefined;
  loadMock.mockReset();
  loadMock.mockImplementation((field: string) => {
    if (field === `quickbooks-config:${APP}`) return Promise.resolve(appConfigResponse);
    if (field.startsWith('quickbooks-config:')) return Promise.resolve(configResponse);
    return Promise.resolve(tokensResponse);
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAuthorizeUrl (#1210)', () => {
  it('includes client_id, redirect_uri, scope, and state (from per-DID config)', async () => {
    setConfig();
    const url = await buildAuthorizeUrl(OWNER, 'state123');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=state123');
    expect(url).toContain('scope=com.intuit.quickbooks.accounting');
    expect(url).toContain(encodeURIComponent('https://imajin.test/quickbooks/callback'));
  });
});

describe('buildAuthorizeUrl — actionable no-config error (#1775)', () => {
  afterEach(() => {
    delete process.env.PLATFORM_DID;
  });

  it('rewrites quickbooks_no_config into actionable copy naming the platform DID', async () => {
    process.env.PLATFORM_DID = 'did:imajin:platform';

    await expect(buildAuthorizeUrl(OWNER, 'state123')).rejects.toThrow(
      /administrator needs to seal it to the platform DID \(did:imajin:platform\)/,
    );
  });

  it('falls back to generic setup guidance when PLATFORM_DID is unset', async () => {
    delete process.env.PLATFORM_DID;

    await expect(buildAuthorizeUrl(OWNER, 'state123')).rejects.toThrow(
      /set PLATFORM_DID and seal the Intuit Client ID\/Secret/,
    );
  });

  it('passes through unrelated connector errors unchanged', async () => {
    configResponse = JSON.stringify({ clientId: 'cid', flow: 'device' });

    await expect(buildAuthorizeUrl(OWNER, 'state123')).rejects.toThrow(/quickbooks_flow_mismatch/);
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

describe('listActiveGrantOwners (xprize #35 cron reconcile)', () => {
  it('returns distinct owner DIDs whose active row includes the scope', async () => {
    whereMock.mockResolvedValue([
      { did: OWNER, scopes: ['quickbooks:read'] },
      { did: 'did:imajin:other-supplier', scopes: ['quickbooks:write'] },
      { did: OWNER, scopes: ['quickbooks:read'] },
    ]);

    expect(await listActiveGrantOwners('quickbooks:read')).toEqual([OWNER]);
  });

  it('returns an empty list when no active rows include the scope', async () => {
    whereMock.mockResolvedValue([{ did: OWNER, scopes: ['quickbooks:write'] }]);
    expect(await listActiveGrantOwners('quickbooks:read')).toEqual([]);
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
    setConfig();
    await expect(readInvoices(OWNER)).rejects.toThrow(/no_tokens/);
  });

  it('returns normalized invoices from the sandbox API', async () => {
    grant(['quickbooks:read']);
    setConfig();
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
    setConfig();
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
    setConfig();
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

  it('upserts the realmId -> ownerDid reverse index, appDid falling back to ownerDid (xprize #35)', async () => {
    setConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    });

    await exchangeCodeAndStore(OWNER, 'code123', 'realm9');

    expect(upsertRealmIndexMock).toHaveBeenCalledWith('realm9', OWNER, OWNER);
  });

  it('loads client credentials from configDid while sealing tokens at ownerDid (#1704)', async () => {
    setAppConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    });

    await exchangeCodeAndStore(OWNER, 'code123', 'realm9', APP);

    const [field] = sealMock.mock.calls[0];
    expect(field).toBe(vaultField(OWNER));
    const headers = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('app-cid:app-csecret').toString('base64')}`);
  });

  it('upserts the realmId index with the configDid as appDid (xprize #35, split-config)', async () => {
    setAppConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    });

    await exchangeCodeAndStore(OWNER, 'code123', 'realm9', APP);

    expect(upsertRealmIndexMock).toHaveBeenCalledWith('realm9', OWNER, APP);
  });
});

describe('refreshTokens (#1704)', () => {
  it('refreshes using the configDid client credentials and seals at ownerDid', async () => {
    setAppConfig();
    sealedTokens({ expiresAt: Date.now() - 1000 });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
    });

    const tokens = await refreshTokens(OWNER, APP);

    expect(tokens?.accessToken).toBe('at2');
    const headers = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('app-cid:app-csecret').toString('base64')}`);
    expect(sealMock).toHaveBeenCalledWith(vaultField(OWNER), expect.any(String));
  });

  it('falls back to the owner-owned config when configDid is omitted (BYO-app, unchanged)', async () => {
    setConfig();
    sealedTokens({ expiresAt: Date.now() - 1000 });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
    });

    await refreshTokens(OWNER);

    const headers = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  });

  it('returns undefined when no tokens are sealed for the owner', async () => {
    setConfig();
    expect(await refreshTokens(OWNER)).toBeUndefined();
  });
});

describe('createInvoice (#1210 write-back)', () => {
  it('posts an invoice stamped with the lot correlationId and normalizes the result', async () => {
    const accessToken = 'qb-access-token-SUPER-SECRET';
    grant(['quickbooks:write']);
    setConfig();
    sealedTokens({ accessToken });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ Invoice: { Id: '55', DocNumber: '1042', TotalAmt: 42, Balance: 42, CurrencyRef: { value: 'CAD' }, TxnDate: '2026-07-10', CustomerRef: { name: 'David' }, PrivateNote: 'imajin-lot:lot_eggs_1' } }),
    });

    const invoice = await createInvoice(OWNER, {
      correlationId: 'lot_eggs_1',
      customerRef: '12',
      lines: [{ amount: 42, itemRef: '7', quantity: 12, unitPrice: 3.5, description: 'Eggs' }],
    });

    expect(invoice).toMatchObject({ id: '55', balance: 42, correlationId: 'lot_eggs_1', customerName: 'David' });

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('sandbox-quickbooks.api.intuit.com/v3/company/r1/invoice');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${accessToken}` });
    const sent = JSON.parse(init.body as string);
    expect(sent.CustomerRef).toEqual({ value: '12' });
    expect(sent.PrivateNote).toBe('imajin-lot:lot_eggs_1');
    expect(sent.Line[0].Amount).toBe(42);
    expect(sent.Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: '7' });
    expect(JSON.stringify(invoice)).not.toContain(accessToken);
  });

  it('fails closed without a quickbooks:write grant', async () => {
    grant(['quickbooks:read']);
    sealedTokens();
    await expect(
      createInvoice(OWNER, { correlationId: 'x', customerRef: '1', lines: [{ amount: 1, itemRef: '1' }] }),
    ).rejects.toThrow(/no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('storeConfig (#1210 per-DID creds)', () => {
  it('seals the app config under the per-DID config field', async () => {
    await storeConfig(OWNER, CONFIG);
    expect(sealMock).toHaveBeenCalledTimes(1);
    const [field, blob] = sealMock.mock.calls[0];
    expect(field).toBe(configField(OWNER));
    expect(JSON.parse(blob as string)).toMatchObject({ clientId: 'cid', environment: 'sandbox' });
  });
});

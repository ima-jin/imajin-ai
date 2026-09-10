import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealMock, loadMock, publishMock, whereMock, updateSetMock, updateWhereMock, revokeRegistrationMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  publishMock: vi.fn(),
  whereMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  revokeRegistrationMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: sealMock, loadAndUnseal: loadMock }));

vi.mock('@/src/db', () => {
  const channelLinks = { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' };
  return {
    db: {
      select: () => ({ from: () => ({ where: whereMock }) }),
      update: () => ({
        set: (values: unknown) => {
          updateSetMock(values);
          return { where: updateWhereMock };
        },
      }),
    },
    channelLinks,
  };
});

vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('../../kernel/connector-registry-store', () => ({ revokeConnectorRegistration: revokeRegistrationMock }));

import { VaultDelegationError } from '@/src/lib/vault/errors';
import { describeActiveGrantContract } from '../../kernel/__tests__/connector-active-grant-contract';
import {
  buildAuthorizeUrl,
  exchangeCodeAndStore,
  resolveActiveGrant,
  requireGrantAndToken,
  revokeAtGoogle,
  listActiveGrantOwners,
  storeConfig,
  configField,
  oauthVaultField,
  readConfigFlow,
  googleApiFetch,
  googleApiRequest,
  GOOGLE_CONNECTOR_DID,
  GOOGLE_OAUTH_SCOPES,
} from '../connector';

const OWNER = 'did:imajin:jin';
const CONFIG = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://imajin.test/google/api/callback' };

let configResponse: string | undefined;
let tokensResponse: string | undefined;

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

function setConfig(present = true) {
  configResponse = present ? JSON.stringify(CONFIG) : undefined;
}

function sealedTokens(overrides: Record<string, unknown> = {}) {
  tokensResponse = JSON.stringify({
    accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, ...overrides,
  });
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  whereMock.mockReset();
  updateSetMock.mockReset();
  updateWhereMock.mockReset();
  updateWhereMock.mockResolvedValue(undefined);
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  revokeRegistrationMock.mockReset();
  revokeRegistrationMock.mockResolvedValue(undefined);
  configResponse = undefined;
  tokensResponse = undefined;
  loadMock.mockReset();
  loadMock.mockImplementation((field: string) => {
    if (field.startsWith('google-config:')) return Promise.resolve(configResponse);
    return Promise.resolve(tokensResponse);
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GOOGLE_OAUTH_SCOPES (#2144)', () => {
  it('declares one Google API scope per v1 imajin scope', () => {
    expect(Object.keys(GOOGLE_OAUTH_SCOPES).sort()).toEqual([
      'google:calendar:read', 'google:calendar:write', 'google:drive:read',
      'google:gmail:read', 'google:gmail:send', 'google:meet:records',
    ]);
  });
});

describe('buildAuthorizeUrl (#2144)', () => {
  it('requests offline access and forces the consent screen', async () => {
    setConfig();
    const url = await buildAuthorizeUrl(OWNER, 'state123');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=state123');
    expect(url).toContain(encodeURIComponent('https://imajin.test/google/api/callback'));
  });

  it('requests the union of all six v1 Google API scopes', async () => {
    setConfig();
    const url = await buildAuthorizeUrl(OWNER, 'state123');
    const params = new URL(url).searchParams;
    const scope = params.get('scope') ?? '';
    expect(scope).toContain('gmail.readonly');
    expect(scope).toContain('gmail.send');
    expect(scope).toContain('calendar.readonly');
    expect(scope).toContain('calendar.events');
    expect(scope).toContain('drive.readonly');
    expect(scope).toContain('meetings.space.readonly');
  });
});

describe('exchangeCodeAndStore (#2144)', () => {
  it('exchanges the code and seals the token bundle per-DID', async () => {
    setConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    });

    await exchangeCodeAndStore(OWNER, 'code123');

    expect(sealMock).toHaveBeenCalledTimes(1);
    const [field, blob] = sealMock.mock.calls[0];
    expect(field).toBe(oauthVaultField(OWNER));
    expect(JSON.parse(blob as string)).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
  });
});

describeActiveGrantContract({
  connectorLabel: 'google',
  owner: OWNER,
  scope: 'google:gmail:read',
  otherScope: 'google:calendar:read',
  whereMock,
  resolveActiveGrant,
  listActiveGrantOwners,
});

describe('requireGrantAndToken (#2144, fail-closed)', () => {
  it('throws google_no_grant with no active channel_links row', async () => {
    noGrant();
    await expect(requireGrantAndToken(OWNER, 'google:gmail:read')).rejects.toThrow(/google_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws google_no_credential when a grant exists but nothing is sealed', async () => {
    grant(['google:gmail:read']);
    await expect(requireGrantAndToken(OWNER, 'google:gmail:read')).rejects.toThrow(/google_no_credential/);
  });

  it('throws google_credential_pending when the token bundle is sealed behind a pending delegation grant', async () => {
    grant(['google:gmail:read']);
    setConfig();
    loadMock.mockImplementation((field: string) => {
      if (field.startsWith('google-config:')) return Promise.resolve(configResponse);
      return Promise.reject(new VaultDelegationError('pending', { field, nodeDid: 'node' }));
    });
    await expect(requireGrantAndToken(OWNER, 'google:gmail:read')).rejects.toThrow(/google_credential_pending/);
  });

  it('returns a valid access token when granted and sealed', async () => {
    grant(['google:gmail:read']);
    setConfig();
    sealedTokens();
    const token = await requireGrantAndToken(OWNER, 'google:gmail:read');
    expect(token).toBe('at');
    expect(fetch).not.toHaveBeenCalled(); // not expired, no refresh needed
  });

  it('refreshes an expiring access token before returning it', async () => {
    grant(['google:gmail:read']);
    setConfig();
    sealedTokens({ expiresAt: Date.now() - 1000 });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at2', expires_in: 3600 }),
    });

    const token = await requireGrantAndToken(OWNER, 'google:gmail:read');

    expect(token).toBe('at2');
    expect(sealMock).toHaveBeenCalled();
  });

  it('fails closed and tombstones the grant when Google rejects the refresh with invalid_grant (revoked on Google side)', async () => {
    grant(['google:gmail:read']);
    setConfig();
    sealedTokens({ expiresAt: Date.now() - 1000 });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    });

    await expect(requireGrantAndToken(OWNER, 'google:gmail:read')).rejects.toThrow(/google_credential_revoked/);

    // Tombstone bookkeeping ran: local grant revoked, registry mirrored, event published.
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));
    expect(revokeRegistrationMock).toHaveBeenCalledWith(OWNER, 'google');
    expect(publishMock).toHaveBeenCalledWith('connector.disconnected', expect.objectContaining({
      subject: OWNER,
      payload: expect.objectContaining({ connector: 'google' }),
    }));
  });

  it('a subsequent call still fails closed after the grant has been tombstoned', async () => {
    // Once tombstoned, resolveActiveGrant reads no active rows.
    noGrant();
    await expect(requireGrantAndToken(OWNER, 'google:gmail:read')).rejects.toThrow(/google_no_grant/);
  });
});

describe('revokeAtGoogle (our revoke \u2192 Google, #2144)', () => {
  it('posts the refresh token to the revoke endpoint', async () => {
    sealedTokens();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await revokeAtGoogle(OWNER);

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect((init.body as string)).toContain('token=rt');
  });

  it('falls back to the access token when no refresh token is sealed', async () => {
    sealedTokens({ refreshToken: undefined });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await revokeAtGoogle(OWNER);

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.body as string)).toContain('token=at');
  });

  it('is a no-op when nothing is sealed', async () => {
    await revokeAtGoogle(OWNER);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws when the provider request fails (best-effort)', async () => {
    sealedTokens();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    await expect(revokeAtGoogle(OWNER)).resolves.toBeUndefined();
  });

  it('never throws on a non-2xx provider response (best-effort)', async () => {
    sealedTokens();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_token' });
    await expect(revokeAtGoogle(OWNER)).resolves.toBeUndefined();
  });
});

describe('storeConfig / readConfigFlow (#2144)', () => {
  it('seals the app config under the per-DID config field', async () => {
    await storeConfig(OWNER, CONFIG);
    expect(sealMock).toHaveBeenCalledTimes(1);
    const [field, blob] = sealMock.mock.calls[0];
    expect(field).toBe(configField(OWNER));
    expect(JSON.parse(blob as string)).toMatchObject({ clientId: 'cid' });
  });

  it('reports authorization_code once a config is sealed', async () => {
    setConfig();
    expect(await readConfigFlow(OWNER)).toBe('authorization_code');
  });

  it('reports null when nothing is sealed yet', async () => {
    setConfig(false);
    expect(await readConfigFlow(OWNER)).toBeNull();
  });
});

describe('identity constants', () => {
  it('exposes the connector DID', () => {
    expect(GOOGLE_CONNECTOR_DID).toBe('did:imajin:google-connector');
  });
});

/**
 * Direct behavioral tests for `org-provisioning.ts` (#2375, #2416 GitHub
 * App installation credential, #2415 unauthenticated-existence-check-first
 * idempotency) — GitHub App credential parsing, installation-token
 * minting/caching, and idempotent repo-from-template creation. The App JWT
 * minting is exercised against REAL RSA keypairs and verified with
 * `jose.jwtVerify`, so the claims contract is genuinely checked. (#2437: the
 * Actions-secret sealing helper this module used to export is gone; a guard
 * test below keeps it that way.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import * as jose from 'jose';

const { loadAndUnsealMock } = vi.hoisted(() => ({
  loadAndUnsealMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/vault', () => ({
  loadAndUnseal: loadAndUnsealMock,
}));

import * as orgProvisioning from '../org-provisioning';
import {
  loadOrgCredential,
  getInstallationToken,
  tryGetInstallationToken,
  ensureRepoFromTemplate,
  fetchAppManifest,
  OrgCredentialMissingError,
  OrgCredentialMalformedError,
  PROVISIONING_ORG,
  DEFAULT_APP_TEMPLATE,
  __resetInstallationTokenCacheForTests,
  type OrgAppCredential,
} from '../org-provisioning';

const APP_ID = 'app-123456';
const INSTALLATION_ID = 'install-987654';
const INSTALLATION_TOKEN = 'ghs_installation_token';

const { privateKey: PKCS8_PRIVATE_KEY_PEM, publicKey: PUBLIC_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// GitHub Apps' own downloadable private key is PKCS#1 ("BEGIN RSA PRIVATE
// KEY"), not PKCS#8 — see `mintAppJwt`'s docblock for why `createPrivateKey`
// (not jose's `importPKCS8`) is used specifically to support this format.
const { privateKey: PKCS1_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function credentialJson(overrides: Partial<OrgAppCredential> = {}): string {
  return JSON.stringify({
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    privateKeyPem: PKCS8_PRIVATE_KEY_PEM,
    ...overrides,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

function installationTokenResponse(overrides: Partial<{ token: string; expires_at: string }> = {}): Response {
  return jsonResponse(201, {
    token: INSTALLATION_TOKEN,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetInstallationTokenCacheForTests();
  loadAndUnsealMock.mockResolvedValue(credentialJson());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadOrgCredential', () => {
  it('parses a well-formed sealed JSON blob into an OrgAppCredential', async () => {
    await expect(loadOrgCredential()).resolves.toEqual({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPem: PKCS8_PRIVATE_KEY_PEM,
    });
  });

  it('throws OrgCredentialMissingError when the credential was never sealed', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMissingError);
    await expect(loadOrgCredential()).rejects.toThrow('github-org-provisioning is not sealed');
  });

  it('throws OrgCredentialMalformedError when the sealed value is not valid JSON (e.g. a stale pre-#2416 PAT string)', async () => {
    loadAndUnsealMock.mockResolvedValue('ghp_a_raw_pat_token_not_json');
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
    await expect(loadOrgCredential()).rejects.toThrow('not valid JSON');
  });

  it('throws OrgCredentialMalformedError when the sealed JSON is an array, not an object', async () => {
    loadAndUnsealMock.mockResolvedValue(JSON.stringify(['not', 'an', 'object']));
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
  });

  it('throws OrgCredentialMalformedError when the sealed JSON is null', async () => {
    loadAndUnsealMock.mockResolvedValue('null');
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
  });

  it.each(['appId', 'installationId', 'privateKeyPem'] as const)(
    'throws OrgCredentialMalformedError when "%s" is missing',
    async (field) => {
      const blob = JSON.parse(credentialJson()) as Record<string, unknown>;
      delete blob[field];
      loadAndUnsealMock.mockResolvedValue(JSON.stringify(blob));

      await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
      await expect(loadOrgCredential()).rejects.toThrow(`"${field}"`);
    },
  );

  it('throws OrgCredentialMalformedError when a field is present but not a string', async () => {
    loadAndUnsealMock.mockResolvedValue(JSON.stringify({ appId: 123, installationId: INSTALLATION_ID, privateKeyPem: PKCS8_PRIVATE_KEY_PEM }));
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
  });

  it('throws OrgCredentialMalformedError when a field is an empty string', async () => {
    loadAndUnsealMock.mockResolvedValue(credentialJson({ appId: '' }));
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
  });

  it('OrgCredentialMalformedError is a TypeError, distinct from OrgCredentialMissingError', async () => {
    loadAndUnsealMock.mockResolvedValue('not json');
    const error: unknown = await loadOrgCredential().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(OrgCredentialMissingError);
  });
});

describe('getInstallationToken', () => {
  it('mints a fresh installation token by signing a real RS256 App JWT and exchanging it', async () => {
    fetchMock.mockResolvedValueOnce(installationTokenResponse());

    const token = await getInstallationToken();

    expect(token).toBe(INSTALLATION_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(init.method).toBe('POST');

    const authHeader = (init.headers as Record<string, string>).Authorization;
    expect(authHeader).toMatch(/^Bearer .+/);
    const appJwt = authHeader.replace('Bearer ', '');

    const verifyKey = await jose.importSPKI(PUBLIC_KEY_PEM, 'RS256');
    const { payload, protectedHeader } = await jose.jwtVerify(appJwt, verifyKey);
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.iss).toBe(APP_ID);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    // GitHub's own requirements: iat backdated ~60s for clock skew, and a
    // total (iat -> exp) lifetime capped at 10 minutes.
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(payload.iat as number).toBeLessThanOrEqual(nowSeconds - 59);
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
  });

  it('caches the installation token across calls, minting/loading the credential only once', async () => {
    fetchMock.mockResolvedValueOnce(installationTokenResponse());

    const first = await getInstallationToken();
    const second = await getInstallationToken();

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadAndUnsealMock).toHaveBeenCalledTimes(1);
  });

  it('mints a fresh token once the cached one is within 5 minutes of its real expiry', async () => {
    fetchMock
      .mockResolvedValueOnce(installationTokenResponse({ expires_at: new Date(Date.now() + 4 * 60 * 1000).toISOString() }))
      .mockResolvedValueOnce(installationTokenResponse({ token: 'ghs_second_token' }));

    const first = await getInstallationToken();
    const second = await getInstallationToken();

    expect(first).toBe(INSTALLATION_TOKEN);
    expect(second).toBe('ghs_second_token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-mint when the cached token still has more than 5 minutes left', async () => {
    fetchMock.mockResolvedValueOnce(installationTokenResponse({ expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }));

    await getInstallationToken();
    await getInstallationToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates OrgCredentialMissingError before ever calling fetch', async () => {
    loadAndUnsealMock.mockResolvedValueOnce(undefined);
    await expect(getInstallationToken()).rejects.toBeInstanceOf(OrgCredentialMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates OrgCredentialMalformedError before ever calling fetch', async () => {
    loadAndUnsealMock.mockResolvedValueOnce('not json');
    await expect(getInstallationToken()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when GitHub refuses to mint the installation token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Bad credentials' }));

    await expect(getInstallationToken()).rejects.toThrow(
      `apps.provision: failed to mint an installation token for installation '${INSTALLATION_ID}' (GitHub status 401)`,
    );
  });

  it('throws a RangeError when the installation token response has an unparsable expires_at', async () => {
    fetchMock.mockResolvedValueOnce(installationTokenResponse({ expires_at: 'not-a-date' }));

    await expect(getInstallationToken()).rejects.toBeInstanceOf(RangeError);
  });

  it("signs correctly with a PKCS#1 (\"BEGIN RSA PRIVATE KEY\") PEM — GitHub Apps' actual downloadable key format", async () => {
    loadAndUnsealMock.mockResolvedValue(credentialJson({ privateKeyPem: PKCS1_PRIVATE_KEY_PEM }));
    fetchMock.mockResolvedValueOnce(installationTokenResponse());

    await expect(getInstallationToken()).resolves.toBe(INSTALLATION_TOKEN);
  });

  it('never logs or leaks the App private key or the minted installation token in a thrown error message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Bad credentials' }));

    const error: unknown = await getInstallationToken().catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(PKCS8_PRIVATE_KEY_PEM);
  });

  describe('in-flight coalescing (#2431)', () => {
    const CONCURRENT_CALLERS = 10;

    function accessTokenCalls(): unknown[][] {
      return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens'));
    }

    it('N concurrent calls on a cold cache issue exactly one token request and share the result', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(installationTokenResponse()));

      const tokens = await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, () => getInstallationToken()));

      expect(tokens).toEqual(Array.from({ length: CONCURRENT_CALLERS }, () => INSTALLATION_TOKEN));
      expect(accessTokenCalls()).toHaveLength(1);
      expect(loadAndUnsealMock).toHaveBeenCalledTimes(1);
    });

    it('fills the cache once: a later call after the burst reuses it without minting again', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(installationTokenResponse()));

      await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, () => getInstallationToken()));
      await expect(getInstallationToken()).resolves.toBe(INSTALLATION_TOKEN);

      expect(accessTokenCalls()).toHaveLength(1);
      expect(loadAndUnsealMock).toHaveBeenCalledTimes(1);
    });

    it('N concurrent calls on a just-expired cache issue exactly one new token request', async () => {
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(installationTokenResponse({ expires_at: new Date(Date.now() + 60 * 1000).toISOString() })),
      );
      await getInstallationToken();
      fetchMock.mockImplementation(() => Promise.resolve(installationTokenResponse({ token: 'ghs_refreshed' })));

      const tokens = await Promise.all(Array.from({ length: CONCURRENT_CALLERS }, () => getInstallationToken()));

      expect(tokens).toEqual(Array.from({ length: CONCURRENT_CALLERS }, () => 'ghs_refreshed'));
      expect(accessTokenCalls()).toHaveLength(2);
    });

    it('a failed mint rejects every concurrent caller, is not cached, and the next caller retries', async () => {
      fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(401, { message: 'Bad credentials' })));

      const results = await Promise.allSettled(Array.from({ length: CONCURRENT_CALLERS }, () => getInstallationToken()));

      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(accessTokenCalls()).toHaveLength(1);

      fetchMock.mockImplementation(() => Promise.resolve(installationTokenResponse()));
      await expect(getInstallationToken()).resolves.toBe(INSTALLATION_TOKEN);
      expect(accessTokenCalls()).toHaveLength(2);
    });

    it('a failed credential load (e.g. unsealed) also clears the in-flight slot so the next caller retries', async () => {
      loadAndUnsealMock.mockResolvedValueOnce(undefined);

      const results = await Promise.allSettled(Array.from({ length: CONCURRENT_CALLERS }, () => getInstallationToken()));

      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(loadAndUnsealMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockImplementation(() => Promise.resolve(installationTokenResponse()));
      await expect(getInstallationToken()).resolves.toBe(INSTALLATION_TOKEN);
    });
  });
});

describe('tryGetInstallationToken', () => {
  it('returns a real installation token when the credential is sealed', async () => {
    fetchMock.mockResolvedValueOnce(installationTokenResponse());
    await expect(tryGetInstallationToken()).resolves.toBe(INSTALLATION_TOKEN);
  });

  it('returns null (never throws) when the credential was never sealed', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    await expect(tryGetInstallationToken()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates OrgCredentialMalformedError instead of swallowing it as "unsealed"', async () => {
    loadAndUnsealMock.mockResolvedValue('not json');
    await expect(tryGetInstallationToken()).rejects.toBeInstanceOf(OrgCredentialMalformedError);
  });
});

describe('ensureRepoFromTemplate', () => {
  it('#2415: checks existence unauthenticated first, and never loads any credential when the repo already exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${PROVISIONING_ORG}/dykil`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(loadAndUnsealMock).not.toHaveBeenCalled();
  });

  it('creates the repo from the template when the unauthenticated existence check 404s and the credential is sealed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [existenceUrl, existenceInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(existenceUrl).toBe(`https://api.github.com/repos/${PROVISIONING_ORG}/dykil`);
    expect((existenceInit.headers as Record<string, string>).Authorization).toBeUndefined();
    const [createUrl, createInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(createUrl).toBe(`https://api.github.com/repos/${DEFAULT_APP_TEMPLATE}/generate`);
    expect(createInit.method).toBe('POST');
    expect((createInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(JSON.parse(createInit.body as string)).toEqual({
      owner: PROVISIONING_ORG,
      name: 'dykil',
      private: true,
      include_all_branches: false,
    });
  });

  it('uses a caller-supplied template instead of the default', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    await ensureRepoFromTemplate('dykil', 'ima-jin/custom-template');

    const [createUrl] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(createUrl).toBe('https://api.github.com/repos/ima-jin/custom-template/generate');
  });

  it('#2415: repo missing and credential unsealed throws OrgCredentialMissingError with an out-of-band message, and never attempts to create', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(404, { message: 'Not Found' })));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toBeInstanceOf(OrgCredentialMissingError);
    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      /does not exist and github-org-provisioning is not sealed.*gh repo create ima-jin\/dykil --template ima-jin\/imajin-app-template/s,
    );
    // One unauthenticated existence GET per assertion above; no installation
    // token mint and no POST create ever attempted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the repo creation call itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(422, { message: 'Unprocessable' }));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      "apps.provision: failed to create repo 'dykil' from template 'ima-jin/imajin-app-template' (GitHub status 422)",
    );
  });

  it('#2415: retries an ambiguous (non-200, non-404) anonymous status once, authenticated, when the credential is sealed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { message: 'rate limited' }))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(200, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it('#2415: an ambiguous status whose authenticated retry resolves to 404 creates the repo', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { message: 'rate limited' }))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('#2415: an ambiguous status fails closed WITHOUT any authenticated retry when the credential is unsealed', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: 'rate limited' }));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      "apps.provision: failed to check for existing repo 'dykil' (GitHub status 403)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the authenticated retry itself returns an unexpected status', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { message: 'rate limited' }))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(500, { message: 'server error' }));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      "apps.provision: failed to check for existing repo 'dykil' (GitHub status 500)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reuses a cached installation token across two calls instead of re-minting', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }))
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/links', full_name: 'ima-jin/links' }));

    await ensureRepoFromTemplate('dykil');
    await ensureRepoFromTemplate('links');

    // Two existence checks + two creates + exactly ONE token mint — never re-minted.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('no GitHub Actions secrets (#2437)', () => {
  it('exports no Actions-secret writer — the app key can only reach an app via the vault claim path', () => {
    expect(Object.keys(orgProvisioning).filter((name) => /secret/i.test(name))).toEqual([]);
    expect(orgProvisioning).not.toHaveProperty('sealActionsSecret');
  });

  it('a full create-repo flow only ever issues GET and POST requests, never touching /actions/secrets', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }))
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));

    await ensureRepoFromTemplate('dykil');
    await fetchAppManifest('dykil', INSTALLATION_TOKEN);

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, init] of calls) {
      expect(['GET', 'POST']).toContain(init.method);
      expect(url).not.toContain('/actions/secrets');
    }
  });
});

describe('fetchAppManifest (#2425)', () => {
  function contentsResponse(manifest: unknown): Response {
    const encoded = Buffer.from(JSON.stringify(manifest), 'utf-8').toString('base64');
    return jsonResponse(200, { content: encoded, encoding: 'base64' });
  }

  it('returns null (never calls fetch) when the installation token is null', async () => {
    const result = await fetchAppManifest('dykil', null);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the parsed, validated manifest for a 200 response', async () => {
    fetchMock.mockResolvedValueOnce(contentsResponse({
      name: 'Dykil',
      icon: '\ud83d\udccb',
      entryUrl: '/dykil',
      placements: ['launcher', 'home', 'auth-submenu'],
      requiredScope: 'creator',
    }));

    const result = await fetchAppManifest('dykil', INSTALLATION_TOKEN);

    expect(result).toEqual({
      name: 'Dykil',
      icon: '\ud83d\udccb',
      entryUrl: '/dykil',
      placements: ['launcher', 'home', 'auth-submenu'],
      requiredScope: 'creator',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${PROVISIONING_ORG}/dykil/contents/imajin.app.json`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it('returns null (non-fatal) when the file does not exist (404)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('returns null when the response is not base64-encoded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: '{}', encoding: 'none' }));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('returns null when the decoded content is not valid JSON', async () => {
    const encoded = Buffer.from('not json', 'utf-8').toString('base64');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: encoded, encoding: 'base64' }));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('returns null when placements contains an unrecognized value', async () => {
    fetchMock.mockResolvedValueOnce(contentsResponse({ placements: ['launcher', 'not-a-real-placement'] }));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('#2663: passes providesScopes and dependsOn through for later validation', async () => {
    const declarations = {
      providesScopes: ['dykil:read', 'dykil:write'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
    };
    fetchMock.mockResolvedValueOnce(contentsResponse({ name: 'Dykil', ...declarations }));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toEqual({ name: 'Dykil', ...declarations });
  });

  it.each([
    ['providesScopes is not an array', { providesScopes: 'dykil:read' }],
    ['providesScopes holds a non-string', { providesScopes: ['dykil:read', 7] }],
    ['dependsOn is not an array', { dependsOn: 'jin.imajin.ai' }],
    ['dependsOn holds a non-object', { dependsOn: ['jin.imajin.ai'] }],
    ['dependsOn holds null', { dependsOn: [null] }],
  ])('#2663: returns null when %s', async (_label, manifest) => {
    fetchMock.mockResolvedValueOnce(contentsResponse(manifest));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('returns null when a field has the wrong type', async () => {
    fetchMock.mockResolvedValueOnce(contentsResponse({ icon: 42 }));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('never throws when fetch itself rejects (network failure)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toBeNull();
  });

  it('accepts a manifest with only some fields set (all optional)', async () => {
    fetchMock.mockResolvedValueOnce(contentsResponse({ icon: '\u2615' }));

    await expect(fetchAppManifest('coffee', INSTALLATION_TOKEN)).resolves.toEqual({ icon: '\u2615' });
  });
});

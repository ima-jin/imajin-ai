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

const { loadAndUnsealMock, warnMock } = vi.hoisted(() => ({
  loadAndUnsealMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnMock, error: vi.fn() }),
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
  appManifestError,
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

describe('fetchAppManifest (#2813)', () => {
  function contentsResponse(manifest: unknown): Response {
    return jsonResponse(200, {
      content: Buffer.from(JSON.stringify(manifest), 'utf-8').toString('base64'),
      encoding: 'base64',
    });
  }

  it('reads public HEAD without authorization or loading credentials when token is null', async () => {
    const manifest = { name: 'Dykil', secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B' }] };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, manifest));

    await expect(fetchAppManifest('dykil', null)).resolves.toEqual({ ok: manifest });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://raw.githubusercontent.com/ima-jin/dykil/HEAD/imajin.app.json');
    expect(init).toEqual({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(loadAndUnsealMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied organization for the public HEAD read', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(fetchAppManifest('app', null, 'other-org')).resolves.toEqual({ ok: {} });
    expect(fetchMock.mock.calls[0][0]).toBe('https://raw.githubusercontent.com/other-org/app/HEAD/imajin.app.json');
  });

  it('keeps the authenticated Contents API request and default branch unchanged', async () => {
    const manifest = {
      name: 'Dykil', icon: 'icon', entryUrl: '/dykil', placements: ['launcher', 'home', 'auth-submenu'],
      requiredScope: null, providesScopes: ['dykil:read'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
      emittableEvents: ['dykil:created'], secrets: [{ name: 'SESSION_SECRET', kind: 'random-64B' }],
    };
    fetchMock.mockResolvedValueOnce(contentsResponse(manifest));
    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN, 'other-org')).resolves.toEqual({ ok: manifest });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/other-org/dykil/contents/imajin.app.json', {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'imajin-kernel-apps-provision/1.0',
        Authorization: `Bearer ${INSTALLATION_TOKEN}`,
      },
    });
    expect(loadAndUnsealMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  describe.each([['public', null], ['authenticated', INSTALLATION_TOKEN]] as const)('%s read', (_label, token) => {
    function manifestResponse(manifest: unknown): Response {
      if (token === null) return jsonResponse(200, manifest);
      return contentsResponse(manifest);
    }

    it.each([{}, { secrets: [] }, { icon: 'coffee' }])('accepts valid optional fields and absent/empty secrets: %j', async (manifest) => {
      fetchMock.mockResolvedValueOnce(manifestResponse(manifest));
      await expect(fetchAppManifest('coffee', token)).resolves.toEqual({ ok: manifest });
    });

    it.each([204, 301, 401, 403, 404, 429, 500])('classifies HTTP %i as unreadable, retaining only status', async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(status, null));
      await expect(fetchAppManifest('dykil', token)).resolves.toEqual({ error: 'unreadable', status });
      expect(warnMock).toHaveBeenCalledWith(
        { slug: 'dykil', error: 'unreadable', status },
        `App 'dykil' manifest unreadable (HTTP ${status})`,
      );
    });

    it('classifies a non-JSON provider failure as unreadable without logging its body', async () => {
      fetchMock.mockResolvedValueOnce(new Response('PROVIDER_PRIVATE_DATA', { status: 503 }));
      await expect(fetchAppManifest('dykil', token)).resolves.toEqual({ error: 'unreadable', status: 503 });
      expect(warnMock).toHaveBeenCalledWith(
        { slug: 'dykil', error: 'unreadable', status: 503 }, "App 'dykil' manifest unreadable (HTTP 503)",
      );
      expect(JSON.stringify(warnMock.mock.calls)).not.toContain('PROVIDER_PRIVATE_DATA');
    });

    it.each([new Error('NETWORK_PRIVATE_DATA'), new DOMException('TIMEOUT_PRIVATE_DATA', 'TimeoutError')])(
      'classifies transport errors as unreadable and never logs raw errors',
      async (error) => {
        fetchMock.mockRejectedValueOnce(error);
        await expect(fetchAppManifest('dykil', token)).resolves.toEqual({ error: 'unreadable' });
        expect(warnMock).toHaveBeenCalledWith({ slug: 'dykil', error: 'unreadable' }, "App 'dykil' manifest unreadable");
        expect(JSON.stringify(warnMock.mock.calls)).not.toContain('PRIVATE_DATA');
      },
    );

    it('classifies a rejected response-body read as unreadable', async () => {
      fetchMock.mockResolvedValueOnce({ status: 200, text: vi.fn().mockRejectedValue(new Error('BODY_PRIVATE_DATA')) });
      await expect(fetchAppManifest('dykil', token)).resolves.toEqual({ error: 'unreadable' });
      expect(JSON.stringify(warnMock.mock.calls)).not.toContain('BODY_PRIVATE_DATA');
    });

    it('classifies malformed response JSON as invalid without logging parser details', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"SECRET_VALUE": PRIVATE_DATA', { status: 200 }));
      await expect(fetchAppManifest('dykil', token)).resolves.toEqual({ error: 'invalid', status: 200 });
      expect(warnMock).toHaveBeenCalledWith(
        { slug: 'dykil', error: 'invalid', status: 200 }, "App 'dykil' manifest invalid (HTTP 200)",
      );
      expect(JSON.stringify(warnMock.mock.calls)).not.toContain('PRIVATE_DATA');
    });

    it.each([
      null, [], 'not-an-object', 7,
      { name: 7 }, { icon: 7 }, { entryUrl: 7 }, { requiredScope: 7 },
      { placements: 'launcher' }, { placements: ['unknown'] },
      { providesScopes: 'dykil:read' }, { providesScopes: [7] },
      { dependsOn: 'jin.imajin.ai' }, { dependsOn: ['jin.imajin.ai'] }, { dependsOn: [null] },
      { emittableEvents: 'dykil:created' }, { emittableEvents: [7] },
      { secrets: null }, { secrets: {} }, { secrets: 'SESSION_SECRET' },
      { secrets: [null] }, { secrets: ['SESSION_SECRET'] },
      { secrets: [{ name: 'SESSION_SECRET' }] },
      { secrets: [{ kind: 'random-32B' }] },
      { secrets: [{ name: 7, kind: 'random-32B' }] },
      { secrets: [{ name: 'SESSION_SECRET', kind: 7 }] },
      { secrets: [{ name: 'lowercase', kind: 'random-32B' }] },
      { secrets: [{ name: 'SESSION_SECRET', kind: 'provider-secret' }] },
      { secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B', value: 'SECRET_PRIVATE_DATA' }] },
      { secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B', provider: 'PROVIDER_PRIVATE_DATA' }] },
      { secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B' }, { name: 'SESSION_SECRET', kind: 'random-64B' }] },
      { secrets: Array.from({ length: 33 }, (_, index) => ({ name: `SECRET_${index}`, kind: 'random-32B' })) },
    ])('rejects malformed shape or secret declarations: %j', async (manifest) => {
      fetchMock.mockResolvedValueOnce(manifestResponse(manifest));
      await expect(fetchAppManifest('dykil', token)).resolves.toEqual({ error: 'invalid', status: 200 });
      expect(warnMock).toHaveBeenCalledWith(
        { slug: 'dykil', error: 'invalid', status: 200 }, "App 'dykil' manifest invalid (HTTP 200)",
      );
      expect(JSON.stringify(warnMock.mock.calls)).not.toContain('PRIVATE_DATA');
    });
  });

  it.each([null, {}, { encoding: 'none', content: '{}' }, { encoding: 'base64' }, { encoding: 'base64', content: 7 }])(
    'classifies malformed Contents API envelope as invalid: %j', async (body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
      await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toEqual({ error: 'invalid', status: 200 });
    },
  );

  it('classifies malformed decoded JSON as invalid', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      encoding: 'base64', content: Buffer.from('SECRET_PRIVATE_DATA').toString('base64'),
    }));
    await expect(fetchAppManifest('dykil', INSTALLATION_TOKEN)).resolves.toEqual({ error: 'invalid', status: 200 });
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain('SECRET_PRIVATE_DATA');
  });
});

describe('appManifestError', () => {
  it('formats only app name and classification when status is absent', () => {
    expect(appManifestError('dykil', { error: 'unreadable' })).toBe("App 'dykil' manifest unreadable");
    expect(appManifestError('dykil', { error: 'invalid' })).toBe("App 'dykil' manifest invalid");
  });

  it('adds the optional HTTP status without reading extra payload fields', () => {
    const result = { error: 'invalid' as const, status: 200, value: 'SECRET_PRIVATE_DATA', cause: new Error('PROVIDER_PRIVATE_DATA') };
    expect(appManifestError('dykil', result)).toBe("App 'dykil' manifest invalid (HTTP 200)");
    expect(appManifestError('dykil', { error: 'unreadable', status: 404 })).toBe("App 'dykil' manifest unreadable (HTTP 404)");
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

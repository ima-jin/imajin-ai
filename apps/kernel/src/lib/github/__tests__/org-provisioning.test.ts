/**
 * Direct behavioral tests for `org-provisioning.ts` (#2375, existence-check
 * idempotency reworked by #2415) — the GitHub org-scoped credential loading,
 * idempotent repo-from-template creation, and Actions-secret sealing.
 * `sealActionsSecret` is exercised against the REAL `libsodium-wrappers`
 * `crypto_box_seal`/`crypto_box_seal_open` pair (not mocked) so the
 * encryption round-trip is genuinely verified, not just "some function was
 * called".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers');

const { loadAndUnsealMock } = vi.hoisted(() => ({
  loadAndUnsealMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/vault', () => ({
  loadAndUnseal: loadAndUnsealMock,
}));

import {
  loadOrgCredential,
  tryLoadOrgCredential,
  ensureRepoFromTemplate,
  sealActionsSecret,
  OrgCredentialMissingError,
  PROVISIONING_ORG,
  DEFAULT_APP_TEMPLATE,
} from '../org-provisioning';

const ORG_TOKEN = 'ghp_org-scoped-test-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  loadAndUnsealMock.mockResolvedValue(ORG_TOKEN);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadOrgCredential', () => {
  it('returns the sealed org credential', async () => {
    await expect(loadOrgCredential()).resolves.toBe(ORG_TOKEN);
  });

  it('throws OrgCredentialMissingError when the credential was never sealed', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    await expect(loadOrgCredential()).rejects.toBeInstanceOf(OrgCredentialMissingError);
    await expect(loadOrgCredential()).rejects.toThrow('github-org-provisioning is not sealed');
  });
});

describe('tryLoadOrgCredential', () => {
  it('returns the sealed org credential', async () => {
    await expect(tryLoadOrgCredential()).resolves.toBe(ORG_TOKEN);
  });

  it('returns null (never throws) when the credential was never sealed', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    await expect(tryLoadOrgCredential()).resolves.toBeNull();
  });
});

describe('ensureRepoFromTemplate', () => {
  it('#2415: checks existence unauthenticated first, and never loads the credential when the repo already exists', async () => {
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

  it('creates the repo from the template when unauthenticated 404 says it does not exist and the credential is sealed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [existenceUrl, existenceInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(existenceUrl).toBe(`https://api.github.com/repos/${PROVISIONING_ORG}/dykil`);
    expect((existenceInit.headers as Record<string, string>).Authorization).toBeUndefined();
    const [createUrl, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(createUrl).toBe(`https://api.github.com/repos/${DEFAULT_APP_TEMPLATE}/generate`);
    expect(createInit.method).toBe('POST');
    expect((createInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${ORG_TOKEN}`);
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
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    await ensureRepoFromTemplate('dykil', 'ima-jin/custom-template');

    const [createUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(createUrl).toBe('https://api.github.com/repos/ima-jin/custom-template/generate');
  });

  it('#2415: repo missing and credential unsealed throws OrgCredentialMissingError with an out-of-band message, and never attempts to create', async () => {
    loadAndUnsealMock.mockResolvedValue(undefined);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(404, { message: 'Not Found' })));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toBeInstanceOf(OrgCredentialMissingError);
    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      /does not exist and github-org-provisioning is not sealed.*gh repo create ima-jin\/dykil --template ima-jin\/imajin-app-template/s,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // one GET per assertion above, no POST ever attempted
  });

  it('fails closed when the repo creation call itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(jsonResponse(422, { message: 'Unprocessable' }));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      "apps.provision: failed to create repo 'dykil' from template 'ima-jin/imajin-app-template' (GitHub status 422)",
    );
  });

  it('#2415: retries an ambiguous (non-200, non-404) anonymous status once, authenticated, when the credential is sealed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { message: 'rate limited' }))
      .mockResolvedValueOnce(jsonResponse(200, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${ORG_TOKEN}`);
  });

  it('#2415: an ambiguous status whose authenticated retry resolves to 404 creates the repo', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, { message: 'rate limited' }))
      .mockResolvedValueOnce(jsonResponse(404, null))
      .mockResolvedValueOnce(jsonResponse(201, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' }));

    const result = await ensureRepoFromTemplate('dykil');

    expect(result).toEqual({ repoUrl: 'https://github.com/ima-jin/dykil', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('#2415: an ambiguous status fails closed WITHOUT a retry when the credential is unsealed', async () => {
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
      .mockResolvedValueOnce(jsonResponse(500, { message: 'server error' }));

    await expect(ensureRepoFromTemplate('dykil')).rejects.toThrow(
      "apps.provision: failed to check for existing repo 'dykil' (GitHub status 500)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('sealActionsSecret', () => {
  it('propagates OrgCredentialMissingError before ever calling fetch', async () => {
    loadAndUnsealMock.mockResolvedValueOnce(undefined);
    await expect(sealActionsSecret('ima-jin/dykil', 'IMAJIN_APP_PRIVATE_KEY', 'secret')).rejects.toBeInstanceOf(OrgCredentialMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when fetching the Actions public key fails, never attempting to encrypt/PUT', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));

    await expect(sealActionsSecret('ima-jin/dykil', 'IMAJIN_APP_PRIVATE_KEY', 'secret-plaintext')).rejects.toThrow(
      "apps.provision: failed to fetch Actions public key for 'ima-jin/dykil' (GitHub status 404)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the PUT to store the encrypted secret fails', async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { key_id: 'key123', key: publicKeyBase64 }))
      .mockResolvedValueOnce(jsonResponse(403, { message: 'Forbidden' }));

    await expect(sealActionsSecret('ima-jin/dykil', 'IMAJIN_APP_PRIVATE_KEY', 'secret-plaintext')).rejects.toThrow(
      "apps.provision: failed to seal Actions secret 'IMAJIN_APP_PRIVATE_KEY' into 'ima-jin/dykil' (GitHub status 403)",
    );
  });

  it('encrypts the plaintext with a REAL libsodium sealed box the repo can decrypt, and never logs/leaks it', async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
    const plaintext = 'ed25519-private-key-do-not-leak';

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { key_id: 'key123', key: publicKeyBase64 }))
      .mockResolvedValueOnce(jsonResponse(201, null));

    await sealActionsSecret('ima-jin/dykil', 'IMAJIN_APP_PRIVATE_KEY', plaintext);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [publicKeyUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(publicKeyUrl).toBe('https://api.github.com/repos/ima-jin/dykil/actions/secrets/public-key');

    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('https://api.github.com/repos/ima-jin/dykil/actions/secrets/IMAJIN_APP_PRIVATE_KEY');
    expect(putInit.method).toBe('PUT');

    const body = JSON.parse(putInit.body as string) as { encrypted_value: string; key_id: string };
    expect(body.key_id).toBe('key123');
    // The request body must never contain the plaintext directly.
    expect(putInit.body as string).not.toContain(plaintext);

    // Decrypt with the REAL private key to prove the sealed box actually
    // opens to the original plaintext — a genuine round-trip, not just a
    // "some ciphertext was sent" assertion.
    const sealedBytes = sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL);
    const opened = sodium.crypto_box_seal_open(sealedBytes, keypair.publicKey, keypair.privateKey);
    expect(sodium.to_string(opened)).toBe(plaintext);
  });

  it('also succeeds against a 204 No Content PUT response (GitHub\'s actual real-world response for this endpoint)', async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { key_id: 'key123', key: publicKeyBase64 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(sealActionsSecret('ima-jin/dykil', 'GITHUB_PACKAGES_TOKEN', 'token-plaintext')).resolves.toBeUndefined();
  });
});

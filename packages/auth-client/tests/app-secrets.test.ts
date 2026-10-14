import { randomBytes } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { deriveXKeypairFromEd25519, wrapFieldKey, sealSecret } from '@imajin/vault-core';
import { generateBootstrapKeypair } from '../src/ed25519';
import { APP_SECRET_X_DOMAIN, openAppSecretEnvelope, type AppSecretFetchPayload } from '../src/app-secret-envelope';
import { loadFromVault } from '../src/load-from-vault';

const { readKeystoreMock } = vi.hoisted(() => ({ readKeystoreMock: vi.fn() }));
vi.mock('../src/keystore', () => ({
  readKeystore: readKeystoreMock, resolveKeystorePath: () => '/fake-keystore',
}));

const bootstrap = generateBootstrapKeypair();
const recipient = deriveXKeypairFromEd25519(bootstrap.privateKey, APP_SECRET_X_DOMAIN);
const sender = deriveXKeypairFromEd25519(generateBootstrapKeypair().privateKey, 'test-envelope-sender');
const options = {
  appDid: 'did:imajin:test-app', kernelUrl: 'https://kernel.example',
  keys: [{ key: 'SESSION_SECRET', onMissing: 'fail' as const }],
};

function envelope(request: AppSecretFetchPayload, overrides = {}) {
  const fieldKey = randomBytes(32);
  return {
    version: 1 as const, senderXPub: sender.publicKey,
    wrappedKey: wrapFieldKey(fieldKey, request.recipientXPub, sender.privateKey),
    sealed: sealSecret(JSON.stringify({
      domain: request.domain, appDid: request.appDid, nonce: request.nonce, keys: request.keys,
      values: { [request.keys[0]]: 'FAKE_TEST_SECRET' }, missing: [], ...overrides,
    }), fieldKey),
  };
}

beforeEach(() => { readKeystoreMock.mockReturnValue(bootstrap); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('app-declared secret SDK', () => {
  it('loads sealed values into memory using keystore, never sends private keys', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ domain: 'app-self-secrets-v1', appDid: options.appDid, keys: ['SESSION_SECRET'] });
      expect(body.recipientXPub).toBe(recipient.publicKey);
      expect(init.body).not.toContain(bootstrap.privateKey);
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store', method: 'POST' });
      return Response.json(envelope(body));
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadFromVault(options)).toEqual({ values: { SESSION_SECRET: 'FAKE_TEST_SECRET' }, degraded: [] });
  });

  it('omits optional unavailable names independently of required names', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return body.keys[0] === 'OPTIONAL' ? Response.json({ error: 'FAKE_SECRET_ERROR' }, { status: 403 })
        : Response.json(envelope(body));
    }));
    expect(await loadFromVault({ ...options, keys: [
      { key: 'OPTIONAL', onMissing: 'degrade' }, ...options.keys,
    ] })).toEqual({ values: { SESSION_SECRET: 'FAKE_TEST_SECRET' }, degraded: ['OPTIONAL'] });
  });

  it.each(['network', 'response', 'tamper'])('redacts %s failures', async (mode) => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (mode === 'network') throw new Error('FAKE_TEST_SECRET');
      if (mode === 'response') return Response.json({ error: 'FAKE_TEST_SECRET' }, { status: 500 });
      return Response.json(envelope(JSON.parse(init.body), { nonce: 'foreign-nonce' }));
    }));
    await expect(loadFromVault(options)).rejects.toThrow('loadFromVault: required app secret unavailable');
  });

  it.each(['http://kernel.example', 'ftp://localhost', 'https://user:password@kernel.example'])('rejects unsafe URL %s', async (kernelUrl) => {
    await expect(loadFromVault({ ...options, kernelUrl })).rejects.toThrow('HTTPS');
  });

  it('allows literal loopback HTTP', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => Response.json(envelope(JSON.parse(init.body)))));
    expect((await loadFromVault({ ...options, kernelUrl: 'http://127.0.0.1:3000' })).values.SESSION_SECRET).toBe('FAKE_TEST_SECRET');
  });

  it('fails before HTTP without a bootstrap keystore', async () => {
    readKeystoreMock.mockReturnValue(null);
    await expect(loadFromVault(options)).rejects.toThrow('bootstrap keystore required');
  });

  it('checks decrypted DID, nonce, names and refuses wrong keys and ciphertext tampering', () => {
    const request: AppSecretFetchPayload = {
      domain: 'app-self-secrets-v1', appDid: options.appDid, keys: ['SESSION_SECRET'],
      nonce: 'nonce-test', timestamp: Date.now(), recipientXPub: recipient.publicKey,
    };
    for (const override of [{ appDid: 'foreign-app' }, { nonce: 'foreign-nonce' },
      { keys: ['FOREIGN'] }, { values: { FOREIGN: 'FAKE_TEST_SECRET' } }]) {
      expect(() => openAppSecretEnvelope(envelope(request, override), recipient.privateKey, request)).toThrow('invalid sealed response');
    }
    const sealed = envelope(request);
    expect(() => openAppSecretEnvelope(sealed, sender.privateKey, request)).toThrow('invalid sealed response');
    sealed.sealed.encrypted = 'AAAA';
    expect(() => openAppSecretEnvelope(sealed, recipient.privateKey, request)).toThrow('invalid sealed response');
  });
});

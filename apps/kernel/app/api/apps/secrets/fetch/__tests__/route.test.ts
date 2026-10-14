import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveXKeypairFromEd25519 } from '@imajin/vault-core';
import { generateBootstrapKeypair, signBootstrapPayload } from '../../../../../../../../packages/auth-client/src/ed25519';
import { APP_SECRET_X_DOMAIN, canonicalizeAppSecretFetchPayload, openAppSecretEnvelope, type AppSecretFetchPayload } from '../../../../../../../../packages/auth-client/src/app-secret-envelope';

const { binding, fetchSecret, listSecrets } = vi.hoisted(() => ({
  binding: vi.fn(), fetchSecret: vi.fn(), listSecrets: vi.fn(),
}));
vi.mock('@/src/lib/apps/signing-key-claims', () => ({ resolveActiveBootstrapBinding: binding }));
vi.mock('@/src/lib/apps/self-secrets', () => ({ fetchAppDeclaredSecret: fetchSecret, listAppDeclaredSecrets: listSecrets }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
import { POST } from '../route';
import { _resetBootstrapFetchNonceGuardForTests } from '@/src/lib/apps/bootstrap-fetch-auth';

const bootstrap = generateBootstrapKeypair();
const registered = generateBootstrapKeypair();
const recipient = deriveXKeypairFromEd25519(bootstrap.privateKey, APP_SECRET_X_DOMAIN);
function signed(overrides = {}, privateKey = bootstrap.privateKey) {
  const body: AppSecretFetchPayload = {
    domain: 'app-self-secrets-v1', appDid: 'did:imajin:app-test', keys: ['SESSION_SECRET'],
    recipientXPub: recipient.publicKey, nonce: crypto.randomUUID(), timestamp: Date.now(), ...overrides,
  };
  return { ...body, signature: signBootstrapPayload(canonicalizeAppSecretFetchPayload(body), privateKey) };
}
function request(body: unknown, url = 'https://kernel.example/api/apps/secrets/fetch') {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  _resetBootstrapFetchNonceGuardForTests();
  binding.mockResolvedValue({ appDid: 'did:imajin:app-test', boundPublicKey: bootstrap.publicKey });
  listSecrets.mockResolvedValue([{ name: 'SESSION_SECRET', status: 'active' }]);
  fetchSecret.mockResolvedValue({ value: 'FAKE_TEST_SECRET', grantId: 'test-grant', field: 'test-field' });
});
describe('sealed app-secret route', () => {
  it('returns only ciphertext decryptable by the bootstrap recipient', async () => {
    const body = signed();
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain('FAKE_TEST_SECRET');
    expect(text).not.toContain('test-grant');
    expect(openAppSecretEnvelope(JSON.parse(text), recipient.privateKey, body).values.SESSION_SECRET).toBe('FAKE_TEST_SECRET');
    expect(fetchSecret).toHaveBeenCalledWith(body.appDid, 'SESSION_SECRET');
  });
  it('refuses registered app key instead of bound keystore key', async () => {
    expect((await POST(request(signed({}, registered.privateKey)))).status).toBe(403);
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it('allows a production TLS ingress to use an internal HTTP Next URL', async () => {
    expect((await POST(request(signed(), 'http://kernel-internal:3000/api/apps/secrets/fetch'))).status).toBe(200);
  });
  it('refuses fractional timestamps before authentication or secret lookup', async () => {
    expect((await POST(request(signed({ timestamp: Date.now() + 0.5 })))).status).toBe(400);
    expect(binding).not.toHaveBeenCalled();
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it.each([
    null, [], 'FAKE_TEST_SECRET', 1, {},
    { keys: 'FAKE_TEST_SECRET' }, { keys: ['SESSION_SECRET', 'SESSION_SECRET'] },
    { keys: ['not-a-declaration'] }, { nonce: '' }, { nonce: 'x'.repeat(201) },
    { timestamp: 'FAKE_TEST_SECRET' }, { timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { signature: 'FAKE_TEST_SECRET' }, { recipientXPub: 'FAKE_TEST_SECRET' },
    { appDid: '' }, { appDid: 'x'.repeat(257) }, { extra: 'FAKE_TEST_SECRET' },
  ])('refuses malformed input without reflecting body or provider values: %j', async (malformed) => {
    const body = malformed && typeof malformed === 'object' && !Array.isArray(malformed) && Object.keys(malformed).length > 0
      ? { ...signed(), ...malformed } : malformed;
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('{"error":"App secret access refused"}');
    expect(binding).not.toHaveBeenCalled();
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it('redacts malformed JSON and never reaches crypto/decrypt', async () => {
    const response = await POST(new NextRequest('http://internal/api/apps/secrets/fetch', {
      method: 'POST', body: '{"secret":"FAKE_TEST_SECRET"',
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('{"error":"App secret access refused"}');
    expect(binding).not.toHaveBeenCalled();
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it.each(['appDid', 'keys', 'recipientXPub', 'nonce', 'timestamp', 'domain'])('binds %s into signature', async (field) => {
    const body = signed();
    const changed = {
      ...body, [field]: field === 'keys' ? ['FOREIGN'] : field === 'timestamp' ? body.timestamp - 1
        : field === 'recipientXPub' ? recipient.publicKey.split('').reverse().join('') : 'tampered',
    };
    expect((await POST(request(changed))).status).not.toBe(200);
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it('refuses replay and stale requests', async () => {
    const body = signed();
    expect((await POST(request(body))).status).toBe(200);
    expect((await POST(request(body))).status).toBe(403);
    expect((await POST(request(signed({ timestamp: Date.now() - 120000 })))).status).toBe(403);
  });
  it.each(['undeclared', 'revoked', 'inactive'])('refuses %s without decrypting', async (mode) => {
    if (mode === 'inactive') listSecrets.mockRejectedValue(new Error('FAKE_TEST_SECRET'));
    else listSecrets.mockResolvedValue(mode === 'revoked' ? [{ name: 'SESSION_SECRET', status: 'revoked' }] : []);
    const response = await POST(request(signed()));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('FAKE_TEST_SECRET');
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it('refuses unbound apps before secret access', async () => {
    binding.mockResolvedValue(null);
    expect((await POST(request(signed()))).status).toBe(403);
    expect(fetchSecret).not.toHaveBeenCalled();
  });
  it('redacts decrypt/provider errors with no-store', async () => {
    fetchSecret.mockRejectedValue(new Error('FAKE_TEST_SECRET'));
    const response = await POST(request(signed()));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('{"error":"App secret access refused"}');
  });
});

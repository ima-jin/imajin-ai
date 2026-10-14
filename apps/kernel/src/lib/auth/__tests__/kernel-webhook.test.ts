import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeKeyKid, crypto as authCrypto } from '@imajin/auth';
import { createMemoryKernelWebhookNonceStore, verifyKernelWebhook, type KernelWebhookKey } from '@imajin/auth/kernel-webhook';
import { getKernelSigningKeyDocument } from '../kernel-signing-key';
import { kernelWebhookUrl, postKernelWebhook, signKernelWebhook } from '../kernel-webhook';

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => log }));

const apps = ['events', 'market', 'learn', 'coffee'] as const;
const fetchMock = vi.fn();
let publicKey: string;

function canonical(headers: Record<string, string>, url: string, body: string, method = 'POST'): string {
  const target = new URL(url);
  return `imajin-webhook-v1\n${headers['x-kernel-timestamp']}\n${headers['x-kernel-nonce']}\n${method}\n${target.pathname}${target.search}\n${createHash('sha256').update(body).digest('hex')}`;
}

describe('published kernel webhook signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const keypair = authCrypto.generateKeypair();
    publicKey = keypair.publicKey;
    vi.stubEnv('AUTH_PRIVATE_KEY', keypair.privateKey);
    for (const app of apps) vi.stubEnv(`${app.toUpperCase()}_WEBHOOK_SECRET`, '');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('signs the exact raw UTF-8 body, method, path and query with the published key', () => {
    const url = 'https://app.test/base/api/webhook?a=%2F&b=two';
    const body = '{ "message": "héllo", "amount": 2 }\n';
    const headers = signKernelWebhook(url, body);
    expect(headers['x-kernel-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-kernel-nonce']).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    expect(headers['x-kernel-signature']).toMatch(/^[\da-f]{128}$/);
    expect(headers['x-kernel-kid']).toBe(computeKeyKid(publicKey));
    expect(getKernelSigningKeyDocument()?.current).toBe(headers['x-kernel-kid']);
    expect(getKernelSigningKeyDocument()?.keys[0].publicKey).toBe(publicKey);
    expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical(headers, url, body), publicKey)).toBe(true);
    for (const [changedUrl, changedBody, method] of [
      [url, JSON.stringify(JSON.parse(body)), 'POST'],
      [url.replace('a=%2F', 'a=/'), body, 'POST'],
      [url.replace('/base/', '/other/'), body, 'POST'],
      [url, body, 'GET'],
    ]) {
      expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical(headers, changedUrl, changedBody, method), publicKey)).toBe(false);
    }
  });

  it('normalizes method case and gives each delivery a fresh nonce', () => {
    const one = signKernelWebhook('https://app.test/hook', '{}', 'post');
    const two = signKernelWebhook('https://app.test/hook', '{}');
    expect(one['x-kernel-nonce']).not.toBe(two['x-kernel-nonce']);
    expect(authCrypto.verifySync(one['x-kernel-signature'], canonical(one, 'https://app.test/hook', '{}'), publicKey)).toBe(true);
  });

  it('verifies real serialized outbound bytes through SDK discovery and rejects replay and tampering', async () => {
    const url = 'https://app.test/mounted/api/webhook?tenant=%2F&v=2';
    const payload = { type: 'payment.succeeded', metadata: { message: 'héllo', amount: 100 } };
    await postKernelWebhook(url, payload, 'market');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    let pinned: readonly KernelWebhookKey[] | null = null;
    const discovery = vi.fn(async () => new Response(JSON.stringify(getKernelSigningKeyDocument())));
    const options = {
      authServiceUrl: 'https://kernel.test/auth',
      fetch: discovery as typeof fetch,
      nonceStore: createMemoryKernelWebhookNonceStore(),
      pinStore: {
        load: async () => pinned,
        save: async (_namespace: string, keys: readonly KernelWebhookKey[]) => { pinned = [...keys]; },
        withLock: async <T>(_namespace: string, operation: () => Promise<T>): Promise<T> => operation(),
      },
    };
    await expect(verifyKernelWebhook(new Request(url, init), options)).resolves.toEqual(payload);
    expect(discovery).toHaveBeenCalledWith('https://kernel.test/auth/.well-known/kernel-signing-key', expect.any(Object));
    expect(pinned).toEqual(getKernelSigningKeyDocument()?.keys);
    await expect(verifyKernelWebhook(new Request(url, init), options)).rejects.toMatchObject({ code: 'REPLAY' });
    await expect(verifyKernelWebhook(new Request(url, { ...init, body: '{"type":"tampered"}' }), options))
      .rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(verifyKernelWebhook(new Request(url.replace('tenant=%2F', 'tenant=changed'), init), options))
      .rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('keeps base paths and query bytes when appending callback paths', () => {
    expect(kernelWebhookUrl('https://app.test/base/?tenant=%2F&tenant=2', '/api/webhook'))
      .toBe('https://app.test/base/api/webhook?tenant=%2F&tenant=2');
    expect(kernelWebhookUrl('https://app.test', '/api/webhook')).toBe('https://app.test/api/webhook');
  });

  it.each(apps)('delivers signed %s webhooks without any legacy variables', async (app) => {
    const url = 'https://app.test/api/webhook?q=1';
    await postKernelWebhook(url, { message: 'hello', omitted: undefined }, app);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(init.body).toBe('{"message":"hello"}');
    expect(init.redirect).toBe('error');
    expect(headers).not.toHaveProperty('Authorization');
    expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical(headers, url, init.body as string), publicKey)).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(['', 'invalid'])('never sends unsigned payloads when the configured key is %j', async (key) => {
    vi.stubEnv('AUTH_PRIVATE_KEY', key);
    await expect(postKernelWebhook('https://app.test/hook', {}, 'market')).rejects.toThrow('AUTH_PRIVATE_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports the same PKCS#8 encoding as the published key endpoint', () => {
    const seed = process.env.AUTH_PRIVATE_KEY!;
    vi.stubEnv('AUTH_PRIVATE_KEY', `302e020100300506032b657004220420${seed}`);
    const headers = signKernelWebhook('https://app.test/hook', '{}');
    expect(headers['x-kernel-kid']).toBe(computeKeyKid(publicKey));
    expect(authCrypto.verifySync(headers['x-kernel-signature'], canonical(headers, 'https://app.test/hook', '{}'), publicKey)).toBe(true);
  });

  it('adds optional legacy bearer only when set and warns once per variable, never per delivery', async () => {
    for (const app of apps) {
      vi.stubEnv(`${app.toUpperCase()}_WEBHOOK_SECRET`, 'obvious-fake-legacy-placeholder');
      for (let i = 0; i < 2; i++) await postKernelWebhook('https://app.test/hook', {}, app);
    }
    expect(log.warn).toHaveBeenCalledTimes(4);
    vi.resetModules();
    const secondCopy = await import('../kernel-webhook-legacy');
    secondCopy.legacyWebhookHeaders('market');
    expect(log.warn).toHaveBeenCalledTimes(4);
    for (const app of apps) {
      expect(log.warn).toHaveBeenCalledWith(
        { variable: `${app.toUpperCase()}_WEBHOOK_SECRET` },
        expect.stringContaining('Deprecated'),
      );
    }
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Authorization).toBe('Bearer obvious-fake-legacy-placeholder');
      expect(init.headers['x-kernel-signature']).toMatch(/^[\da-f]{128}$/);
    }
  });
});

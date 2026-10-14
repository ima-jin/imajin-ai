import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeKeyKid } from '../src/key-rotation';
import {
  canonicalKernelWebhookPayload,
  createFileKernelWebhookPinStore,
  createMemoryKernelWebhookNonceStore,
  verifyKernelWebhook,
} from '../src/kernel-webhook';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    writeFile: vi.fn(actual.writeFile),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'webhook-faults-'));
  const pinStore = createFileKernelWebhookPinStore(directory);
  const authServiceUrl = 'https://storage-kernel.example/auth';
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const key = {
    kid: computeKeyKid(publicKey), publicKey, algorithm: 'Ed25519',
    validFrom: new Date(0).toISOString(),
  };
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const url = 'https://app.example/callback';
  const body = '{}';
  const signature = sign(null, Buffer.from(canonicalKernelWebhookPayload({
    timestamp, nonce, method: 'POST', url, rawBody: body,
  })), pair.privateKey).toString('hex');
  const request = new Request(url, {
    method: 'POST', body,
    headers: {
      'x-kernel-timestamp': String(timestamp), 'x-kernel-nonce': nonce,
      'x-kernel-kid': key.kid, 'x-kernel-signature': signature,
    },
  });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ current: key.kid, keys: [key] })));
  const nonceStore = createMemoryKernelWebhookNonceStore();
  const filename = join(directory, `${createHash('sha256').update(authServiceUrl).digest('hex')}.json`);
  return { directory, filename, request, options: { pinStore, authServiceUrl, fetch: fetch as typeof globalThis.fetch, nonceStore } };
}

describe('kernel webhook durable-store failure paths', () => {
  it('treats unreadable pin files as failures rather than a new TOFU bootstrap', async () => {
    const { request, options } = await fixture();
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'STORE' });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('rejects corrupt persisted JSON without fetching a replacement pin', async () => {
    const { request, options, filename } = await fixture();
    await writeFile(filename, 'not json');
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'STORE' });
    expect(options.fetch).not.toHaveBeenCalled();
    expect(await readFile(filename, 'utf8')).toBe('not json');
  });

  it('fails closed on a non-contention lock error', async () => {
    const { request, options } = await fixture();
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('filesystem unavailable'), { code: 'EIO' }));
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'STORE' });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it('does not break or bypass a stale lock after the bounded wait', async () => {
    const { request, options, filename } = await fixture();
    const realTime = Date.now();
    await writeFile(`${filename}.lock`, '');
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(realTime).mockReturnValue(realTime + 20_000);
    try {
      await expect(verifyKernelWebhook(request, { ...options, clock: () => realTime }))
        .rejects.toMatchObject({ code: 'STORE' });
      expect(options.fetch).not.toHaveBeenCalled();
      expect(await readFile(`${filename}.lock`, 'utf8')).toBe('');
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the original deadline across lock retries instead of extending the wait', async () => {
    const { request, options } = await fixture();
    const realTime = Date.now();
    const contention = Object.assign(new Error('already locked'), { code: 'EEXIST' });
    vi.mocked(open).mockRejectedValueOnce(contention).mockRejectedValueOnce(contention);
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(realTime)
      .mockReturnValueOnce(realTime + 9999).mockReturnValue(realTime + 10_000);
    try {
      await expect(verifyKernelWebhook(request, { ...options, clock: () => realTime }))
        .rejects.toMatchObject({ code: 'STORE' });
      expect(open).toHaveBeenCalledTimes(2);
      expect(options.fetch).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects pin write failure, leaves no pin, and releases the lock', async () => {
    const { request, options, directory } = await fixture();
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'STORE' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps existing pins intact if atomic replacement fails', async () => {
    const { request, options, filename, directory } = await fixture();
    await verifyKernelWebhook(request.clone(), options);
    const before = await readFile(filename, 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EIO' }));
    await expect(verifyKernelWebhook(request.clone(), options)).rejects.toMatchObject({ code: 'STORE' });
    expect(await readFile(filename, 'utf8')).toBe(before);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it('rejects temporary-file cleanup errors instead of acknowledging the delivery', async () => {
    const { request, options } = await fixture();
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }));
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'STORE' });
  });

  it('rejects lock release failures even if publication and pin persistence succeeded', async () => {
    const { request, options } = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(unlink).mockImplementationOnce(actual.unlink)
      .mockRejectedValueOnce(Object.assign(new Error('lock cleanup denied'), { code: 'EACCES' }));
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'STORE' });
  });
});

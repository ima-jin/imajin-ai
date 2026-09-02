import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../src/logger.js';
import { mintAppToken } from '../src/token-provider.js';
import { generateKeypair } from '@imajin/auth';

describe('logger redaction', () => {
  it('redacts known secret-shaped field names rather than printing them', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('test');

    log.info({ token: 'super-secret-jwt', signature: 'deadbeef', route: 'xai' }, 'minted token');

    expect(spy).toHaveBeenCalledTimes(1);
    const printed = spy.mock.calls[0][0] as string;
    expect(printed).not.toContain('super-secret-jwt');
    expect(printed).not.toContain('deadbeef');
    expect(printed).toContain('"token":"[redacted]"');
    expect(printed).toContain('"signature":"[redacted]"');
    expect(printed).toContain('"route":"xai"');

    spy.mockRestore();
  });

  it('redacts privateKey/apiKey/authorization case-insensitively', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('test');

    log.error({ privateKey: 'seed-hex', apiKey: 'sk-live-xxx', Authorization: 'Bearer abc' }, 'oops');

    const printed = spy.mock.calls[0][0] as string;
    expect(printed).not.toContain('seed-hex');
    expect(printed).not.toContain('sk-live-xxx');
    expect(printed).not.toContain('Bearer abc');

    spy.mockRestore();
  });
});

describe('credentials never appear in a thrown error message', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mintAppToken failure messages never include the signature or private key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid proof-of-possession signature' }), { status: 401 })),
    );
    const keypair = generateKeypair();

    let caught: Error | undefined;
    try {
      await mintAppToken('https://kernel.test', 'did:imajin:app', keypair.privateKey, 'att-1');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(keypair.privateKey);
    // The message legitimately describes *that* PoP failed, but must never carry
    // the raw key material that would let a log-reader forge a future request.
    expect(caught!.message).toBe("Failed to mint app token: 401 Invalid proof-of-possession signature");
  });
});

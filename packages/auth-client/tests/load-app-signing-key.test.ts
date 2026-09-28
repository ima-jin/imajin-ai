/**
 * Tests for `loadAppSigningKey` (#2411) — the boot-time claim-code exchange
 * a third-party app makes to fetch its own vault-minted signing key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAppSigningKey } from '../src/load-app-signing-key';

const KERNEL_URL = 'https://kernel.test';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.IMAJIN_KERNEL_URL;
  delete process.env.IMAJIN_APP_CLAIM_CODE;
});

afterEach(() => {
  delete process.env.IMAJIN_KERNEL_URL;
  delete process.env.IMAJIN_APP_CLAIM_CODE;
});

describe('loadAppSigningKey — success', () => {
  it('resolves the appDid/privateKey/publicKey on a 200 response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' });

    expect(result).toEqual({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' });
  });

  it('posts to {kernelUrl}/api/apps/claim with the claim code and optional hostHint', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: null }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', hostHint: 'dykil-standalone' });

    expect(fetchMock).toHaveBeenCalledWith(
      `${KERNEL_URL}/api/apps/claim`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ claimCode: 'claim_test', hostHint: 'dykil-standalone' }),
      }),
    );
  });

  it('falls back to IMAJIN_KERNEL_URL / IMAJIN_APP_CLAIM_CODE env vars when options are omitted', async () => {
    process.env.IMAJIN_KERNEL_URL = KERNEL_URL;
    process.env.IMAJIN_APP_CLAIM_CODE = 'claim_from_env';
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: null }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadAppSigningKey();

    expect(fetchMock).toHaveBeenCalledWith(
      `${KERNEL_URL}/api/apps/claim`,
      expect.objectContaining({ body: JSON.stringify({ claimCode: 'claim_from_env' }) }),
    );
  });

  it('returns publicKey: null when the kernel omits it', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' });

    expect(result.publicKey).toBeNull();
  });
});

describe('loadAppSigningKey — failure modes (fails loud, never returns null)', () => {
  it('throws when kernelUrl is missing', async () => {
    await expect(loadAppSigningKey({ claimCode: 'claim_test' })).rejects.toThrow(/kernelUrl is required/);
  });

  it('throws when claimCode is missing', async () => {
    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL })).rejects.toThrow(/claimCode is required/);
  });

  it('throws with the kernel\'s error message on a claim-code-reused (410) response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'This claim code has already been redeemed' }), { status: 410 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' }))
      .rejects.toThrow(/already been redeemed/);
  });

  it('throws on a claim-code-expired response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'This claim code has expired — ask the operator to re-approve provisioning for a fresh one' }), { status: 410 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' }))
      .rejects.toThrow(/expired/);
  });

  it('throws on a revoked-grant (403) response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'The app-signing-key grant behind this claim is no longer active (revoked)' }), { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' }))
      .rejects.toThrow(/revoked/);
  });

  it('throws when the kernel is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' }))
      .rejects.toThrow(/could not reach the kernel/);
  });

  it('throws when the response is malformed', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test' }))
      .rejects.toThrow(/malformed/);
  });
});

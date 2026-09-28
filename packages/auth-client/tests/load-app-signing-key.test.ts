/**
 * Tests for `loadAppSigningKey` (#2411, restart-authentication ruling):
 * first boot mints a bootstrap keypair and exchanges a claim code; every
 * later boot signs a challenge with the persisted bootstrap key instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppSigningKey } from '../src/load-app-signing-key';
import { writeKeystore } from '../src/keystore';
import { generateBootstrapKeypair } from '../src/ed25519';

const KERNEL_URL = 'https://kernel.test';
let dir: string;
let keystorePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'imajin-load-key-test-'));
  keystorePath = join(dir, 'keystore.json');
  delete process.env.IMAJIN_KERNEL_URL;
  delete process.env.IMAJIN_APP_CLAIM_CODE;
  delete process.env.IMAJIN_APP_DID;
  delete process.env.IMAJIN_APP_KEYSTORE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.IMAJIN_KERNEL_URL;
  delete process.env.IMAJIN_APP_CLAIM_CODE;
  delete process.env.IMAJIN_APP_DID;
  delete process.env.IMAJIN_APP_KEYSTORE;
});

describe('loadAppSigningKey — first boot (no keystore)', () => {
  it('mints a bootstrap keypair, exchanges the claim code, and persists the keystore only after success', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath });

    expect(result).toEqual({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' });
    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/api/apps/claim`, expect.objectContaining({ method: 'POST' }));
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.claimCode).toBe('claim_test');
    expect(body.bootstrapPublicKey).toMatch(/^[0-9a-f]{64}$/);

    // Keystore was written with a keypair (never the fetched signing key).
    const { readKeystore } = await import('../src/keystore');
    const keystore = readKeystore(keystorePath);
    expect(keystore?.publicKey).toBe(body.bootstrapPublicKey);
    expect(keystore?.privateKey).not.toBe('private-hex');
  });

  it('does NOT persist a keystore when the claim exchange fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 410 })) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath })).rejects.toThrow();

    const { readKeystore } = await import('../src/keystore');
    expect(readKeystore(keystorePath)).toBeNull();
  });

  it('throws a clear, fail-loud message when no keystore exists and no claim code is provided', async () => {
    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, keystorePath }))
      .rejects.toThrow(/no keystore found.*no claim code provided/);
  });

  it('throws with the kernel\'s message on a claim-code-reused (410) response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'This claim code has already been redeemed' }), { status: 410 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath }))
      .rejects.toThrow(/already been redeemed/);
  });
});

describe('loadAppSigningKey — every later boot (keystore present)', () => {
  it('second boot succeeds using the keystore, with NO claim code needed', async () => {
    const bootstrapKeypair = generateBootstrapKeypair();
    writeKeystore(keystorePath, bootstrapKeypair);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath });

    expect(result).toEqual({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' });
    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/api/apps/signing-key/fetch`, expect.objectContaining({ method: 'POST' }));
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.appDid).toBe('did:imajin:abc123');
    expect(typeof body.timestamp).toBe('number');
    expect(typeof body.nonce).toBe('string');
    expect(typeof body.signature).toBe('string');
  });

  it('signs a DIFFERENT nonce on every call', async () => {
    writeKeystore(keystorePath, generateBootstrapKeypair());
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'k', publicKey: null }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath });
    await loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath });

    const nonces = fetchMock.mock.calls.map(([, options]) => JSON.parse((options as RequestInit).body as string).nonce);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  // #2411 required test: second boot with no keystore and no code fails loud.
  it('fails loud with a clear message when the keystore is missing and appDid has no code to fall back on', async () => {
    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, keystorePath }))
      .rejects.toThrow(/no keystore found/);
  });

  it('throws when appDid is missing even though a keystore exists', async () => {
    writeKeystore(keystorePath, generateBootstrapKeypair());

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, keystorePath }))
      .rejects.toThrow(/appDid is required/);
  });

  it('throws on a wrong-bootstrap-key (401) response from the kernel', async () => {
    writeKeystore(keystorePath, generateBootstrapKeypair());
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Invalid bootstrap key signature' }), { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath }))
      .rejects.toThrow(/Invalid bootstrap key signature/);
  });
});

describe('loadAppSigningKey — env var fallbacks', () => {
  it('falls back to IMAJIN_KERNEL_URL / IMAJIN_APP_CLAIM_CODE / IMAJIN_APP_KEYSTORE when options are omitted', async () => {
    process.env.IMAJIN_KERNEL_URL = KERNEL_URL;
    process.env.IMAJIN_APP_CLAIM_CODE = 'claim_from_env';
    process.env.IMAJIN_APP_KEYSTORE = keystorePath;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'k', publicKey: null }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadAppSigningKey();

    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/api/apps/claim`, expect.anything());
  });
});

describe('loadAppSigningKey — general failure modes', () => {
  it('throws when kernelUrl is missing', async () => {
    await expect(loadAppSigningKey({ claimCode: 'x', keystorePath })).rejects.toThrow(/kernelUrl is required/);
  });

  it('throws when the kernel is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath }))
      .rejects.toThrow(/could not reach the kernel/);
  });

  it('throws when the response is malformed', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath }))
      .rejects.toThrow(/malformed/);
  });
});

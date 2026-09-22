import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';

// Mock next/server — not available outside Next.js runtime.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      body,
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
    }),
  },
}));

// Import AFTER mocks are registered.
const { GET } = await import('../kernel-signing-key/route');
const { _resetKernelSigningKeyIssuedAtForTests } = await import('../../../../src/lib/auth/kernel-signing-key');

const ENV_KEYS = ['AUTH_PRIVATE_KEY', 'AUTH_PREVIOUS_PUBLIC_KEY', 'AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL'] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

interface KeyEntry {
  kid: string;
  publicKey: string;
  algorithm: string;
  validFrom: string;
  validUntil?: string;
}

interface MockResponse {
  body: { keys: KeyEntry[]; current: string } | { error: string };
  status: number;
  headers: Record<string, string>;
}

async function invoke(): Promise<MockResponse> {
  return (await GET()) as unknown as MockResponse;
}

beforeEach(() => {
  _resetKernelSigningKeyIssuedAtForTests();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  _resetKernelSigningKeyIssuedAtForTests();
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /auth/.well-known/kernel-signing-key (#2244)', () => {
  it('returns a keys[] entry matching AUTH_PRIVATE_KEY plus a matching current kid, unauthenticated and cacheable', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const response = await invoke();

    expect(response.status).toBe(200);
    const body = response.body as { keys: KeyEntry[]; current: string };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ algorithm: 'Ed25519', publicKey });
    expect(body.keys[0].kid).toBeTruthy();
    expect(body.keys[0].validFrom).toBeTruthy();
    expect(body.current).toBe(body.keys[0].kid);
    expect(response.headers['Cache-Control']).toMatch(/max-age/);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('serves both the current and a grace-window previous key when configured', async () => {
    const current = authCrypto.generateKeypair();
    const previous = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = current.privateKey;
    process.env.AUTH_PREVIOUS_PUBLIC_KEY = previous.publicKey;
    process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL = new Date(Date.now() + 60_000).toISOString();

    const response = await invoke();
    const body = response.body as { keys: KeyEntry[]; current: string };

    expect(body.keys).toHaveLength(2);
    expect(body.keys.map((k) => k.publicKey)).toEqual(expect.arrayContaining([current.publicKey, previous.publicKey]));
    expect(body.current).toBe(body.keys.find((k) => k.publicKey === current.publicKey)?.kid);
    expect(body.keys.find((k) => k.publicKey === previous.publicKey)?.validUntil).toBeTruthy();
  });

  it('never leaks AUTH_PRIVATE_KEY in the response body', async () => {
    const { privateKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const response = await invoke();

    expect(JSON.stringify(response.body)).not.toContain(privateKey);
  });

  it('responds 503 without a body containing any key material when AUTH_PRIVATE_KEY is unset', async () => {
    delete process.env.AUTH_PRIVATE_KEY;

    const response = await invoke();

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: expect.any(String) });
  });
});

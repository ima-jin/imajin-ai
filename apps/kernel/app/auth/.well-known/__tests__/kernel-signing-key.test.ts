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

const ORIGINAL_AUTH_PRIVATE_KEY = process.env.AUTH_PRIVATE_KEY;

interface MockResponse {
  body: { kid: string; alg: string; publicKey: string; issuedAt: string } | { error: string };
  status: number;
  headers: Record<string, string>;
}

async function invoke(): Promise<MockResponse> {
  return (await GET()) as unknown as MockResponse;
}

beforeEach(() => {
  _resetKernelSigningKeyIssuedAtForTests();
});

afterEach(() => {
  _resetKernelSigningKeyIssuedAtForTests();
  if (ORIGINAL_AUTH_PRIVATE_KEY === undefined) delete process.env.AUTH_PRIVATE_KEY;
  else process.env.AUTH_PRIVATE_KEY = ORIGINAL_AUTH_PRIVATE_KEY;
});

describe('GET /auth/.well-known/kernel-signing-key (#2244)', () => {
  it('returns kid/alg/publicKey/issuedAt matching AUTH_PRIVATE_KEY, unauthenticated and cacheable', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ alg: 'Ed25519', publicKey });
    expect((response.body as { kid: string }).kid).toBeTruthy();
    expect((response.body as { issuedAt: string }).issuedAt).toBeTruthy();
    expect(response.headers['Cache-Control']).toMatch(/max-age/);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
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

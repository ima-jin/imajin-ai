/**
 * Tests for GET /auth/api/services/health (#2275).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function makeRequest(service: string): Request {
  const url = `https://kernel.test/auth/api/services/health?service=${encodeURIComponent(service)}`;
  const req = new Request(url);
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return req;
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_COFFEE_URL: 'https://node.example/coffee' };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('GET /auth/api/services/health', () => {
  it('rejects an unknown service with 400', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('not-a-real-service') as never);
    expect(res.status).toBe(400);
  });

  it('reports kernel-native services as ok without a network call', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('pay') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, checked: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails open when no base URL is configured for a userspace service', async () => {
    delete process.env.NEXT_PUBLIC_COFFEE_URL;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: true, checked: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports ok when the service health endpoint responds 2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: true, checked: true, status: 200 });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://node.example/coffee/api/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('reports not-ok when the service health endpoint responds 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: false, checked: true, status: 503 });
  });

  it('reports not-ok when the service is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: false, checked: true, status: 0 });
  });
});

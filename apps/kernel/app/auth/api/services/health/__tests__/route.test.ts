/**
 * Tests for GET /auth/api/services/health (#2275, #2425 send-back).
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

const mocks = vi.hoisted(() => ({
  isActiveRegistryAppSlug: vi.fn(),
  buildPublicUrl: vi.fn(),
}));

vi.mock('@imajin/config', () => ({ buildPublicUrl: mocks.buildPublicUrl }));
vi.mock('@/src/lib/kernel/app-nav', () => ({ isActiveRegistryAppSlug: mocks.isActiveRegistryAppSlug }));

const ORIGINAL_FETCH = globalThis.fetch;

function makeRequest(service: string): Request {
  const url = `https://kernel.test/auth/api/services/health?service=${encodeURIComponent(service)}`;
  const req = new Request(url);
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return req;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.isActiveRegistryAppSlug.mockResolvedValue(false);
  mocks.buildPublicUrl.mockReturnValue('https://node.example/coffee');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('GET /auth/api/services/health', () => {
  it('rejects an unknown service (not kernel-native, not a registered registry app) with 400', async () => {
    mocks.isActiveRegistryAppSlug.mockResolvedValue(false);
    const { GET } = await import('../route');
    const res = await GET(makeRequest('not-a-real-service') as never);
    expect(res.status).toBe(400);
  });

  it('reports kernel-native services as ok without a network call or a registry lookup', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('pay') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, checked: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.isActiveRegistryAppSlug).not.toHaveBeenCalled();
  });

  it('#2425 send-back: accepts any ACTIVE registry.apps slug, not just the historical 6-app list', async () => {
    mocks.isActiveRegistryAppSlug.mockResolvedValue(true);
    mocks.buildPublicUrl.mockReturnValue('https://node.example/a-brand-new-app');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('a-brand-new-app') as never);
    const body = await res.json();

    expect(mocks.isActiveRegistryAppSlug).toHaveBeenCalledWith('a-brand-new-app');
    expect(body).toEqual({ ok: true, checked: true, status: 200 });
  });

  it('fails open when buildPublicUrl resolves to a relative path (single-node mode, no separate origin to probe)', async () => {
    mocks.isActiveRegistryAppSlug.mockResolvedValue(true);
    mocks.buildPublicUrl.mockReturnValue('/coffee');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: true, checked: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports ok when the service health endpoint responds 2xx', async () => {
    mocks.isActiveRegistryAppSlug.mockResolvedValue(true);
    mocks.buildPublicUrl.mockReturnValue('https://node.example/coffee');
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
    mocks.isActiveRegistryAppSlug.mockResolvedValue(true);
    mocks.buildPublicUrl.mockReturnValue('https://node.example/coffee');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: false, checked: true, status: 503 });
  });

  it('reports not-ok when the service is unreachable', async () => {
    mocks.isActiveRegistryAppSlug.mockResolvedValue(true);
    mocks.buildPublicUrl.mockReturnValue('https://node.example/coffee');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const { GET } = await import('../route');
    const res = await GET(makeRequest('coffee') as never);
    const body = await res.json();

    expect(body).toEqual({ ok: false, checked: true, status: 0 });
  });
});

/**
 * GET /auth/api/spec: serves the OpenAPI YAML. The handler is intentionally a
 * non-async function (Sonar S7503) that must still reject — not throw
 * synchronously — when the spec file cannot be read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: h.mockReadFileSync,
}));

describe('auth spec route', () => {
  beforeEach(() => {
    // The route caches the spec at module level; reload for each test.
    vi.resetModules();
    h.mockReadFileSync.mockReset();
  });

  it('serves the spec as text/yaml', async () => {
    h.mockReadFileSync.mockReturnValue('openapi: 3.0.0');
    const { GET } = await import('../route');

    const res = await GET();

    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    expect(await res.text()).toBe('openapi: 3.0.0');
  });

  it('returns a rejected promise (not a synchronous throw) when the spec cannot be read', async () => {
    h.mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    const { GET } = await import('../route');

    let result: Promise<unknown> | undefined;
    expect(() => {
      result = GET();
    }).not.toThrow();

    await expect(result).rejects.toThrow('ENOENT');
  });
});

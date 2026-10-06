/**
 * #2565 — spec/health `GET` handlers and the bump OG image never awaited
 * anything (typescript:S7503), so they are now plain synchronous functions
 * (Next.js accepts a sync return from a route handler). These tests pin both
 * the synchronous contract and the error path: a spec file that cannot be
 * read still fails the request (a throw Next turns into a 500) instead of
 * being swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', () => ({ readFileSync: state.readFileSync, default: { readFileSync: state.readFileSync } }));

const FILE_BACKED_SPECS: Record<string, () => Promise<{ GET: () => Response }>> = {
  calendar: () => import('../calendar/api/spec/route'),
  jin: () => import('../jin/api/spec/route'),
  media: () => import('../media/api/spec/route'),
};

describe('file-backed spec routes (S7503)', () => {
  beforeEach(() => {
    vi.resetModules();
    state.readFileSync.mockReset();
  });

  it.each(Object.keys(FILE_BACKED_SPECS))('%s spec GET synchronously serves cached YAML', async (name) => {
    state.readFileSync.mockReturnValue('openapi: 3.1.0\n');
    const { GET } = await FILE_BACKED_SPECS[name]();

    const first = GET();
    expect(first).not.toBeInstanceOf(Promise);
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('text/yaml');
    expect(await first.text()).toBe('openapi: 3.1.0\n');

    await GET().text();
    expect(state.readFileSync).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(FILE_BACKED_SPECS))('%s spec GET surfaces a read failure by throwing', async (name) => {
    state.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT: spec missing');
    });
    const { GET } = await FILE_BACKED_SPECS[name]();

    expect(() => GET()).toThrow('ENOENT: spec missing');
  });
});

describe('static kernel routes (S7503)', () => {
  it('GET /api/spec synchronously serves the inline YAML', async () => {
    const { GET } = await import('../api/spec/route');
    const response = GET();
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.headers.get('Content-Type')).toBe('text/yaml');
    expect(await response.text()).toContain('title: imajin www');
  });

  it('GET /media/api/health synchronously reports ok', async () => {
    const { GET } = await import('../media/api/health/route');
    const response = GET();
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok', service: 'media' });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('bump opengraph-image default export is synchronous and renders a PNG response', async () => {
    const mod = await import('../bump/opengraph-image');
    const response = mod.default();
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});

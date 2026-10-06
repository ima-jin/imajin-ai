/**
 * #2565 — spec/health `GET` handlers and the bump OG image never awaited
 * anything (typescript:S7503), so they are now plain synchronous functions
 * (Next.js accepts a sync return from a route handler). These tests pin both
 * the synchronous contract and the error path: a spec file that cannot be
 * read still fails the request (a throw Next turns into a 500) instead of
 * being swallowed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', () => ({ readFileSync: state.readFileSync, default: { readFileSync: state.readFileSync } }));

const FILE_BACKED_SPECS: Record<string, () => Promise<{ GET: () => Response }>> = {
  calendar: () => import('../calendar/api/spec/route'),
  jin: () => import('../jin/api/spec/route'),
  media: () => import('../media/api/spec/route'),
};

// Cold route imports belong in hooks with an explicit budget, not inside the
// first `it()` that triggers them: on a loaded CI runner that cost blew the 5s
// testTimeout elsewhere in the kernel suite (#2616).
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

describe('file-backed spec routes (S7503)', () => {
  // These tests must re-import per test (`vi.resetModules()` below: the route
  // caches its YAML at module scope), so the imports themselves cannot be
  // hoisted. Warm the transform/transitive-import cost once beforehand instead;
  // the warm module is discarded by the first `resetModules()`, the cold part is
  // not.
  beforeAll(async () => {
    await Promise.all(Object.values(FILE_BACKED_SPECS).map((load) => load()));
  }, ROUTE_IMPORT_TIMEOUT_MS);

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
  let specRoute: typeof import('../api/spec/route');
  let mediaHealthRoute: typeof import('../media/api/health/route');
  let bumpOpengraph: typeof import('../bump/opengraph-image');

  beforeAll(async () => {
    [specRoute, mediaHealthRoute, bumpOpengraph] = await Promise.all([
      import('../api/spec/route'),
      import('../media/api/health/route'),
      // next/og is the heavy one here.
      import('../bump/opengraph-image'),
    ]);
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it('GET /api/spec synchronously serves the inline YAML', async () => {
    const response = specRoute.GET();
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.headers.get('Content-Type')).toBe('text/yaml');
    expect(await response.text()).toContain('title: imajin www');
  });

  it('GET /media/api/health synchronously reports ok', async () => {
    const response = mediaHealthRoute.GET();
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok', service: 'media' });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('bump opengraph-image default export is synchronous and renders a PNG response', () => {
    const response = bumpOpengraph.default();
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});

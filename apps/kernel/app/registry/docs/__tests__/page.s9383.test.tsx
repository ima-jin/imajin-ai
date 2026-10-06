// @vitest-environment jsdom
/**
 * Registry docs page — S9383 floating-promise fixes (#2568).
 *
 * Both fetch chains in the mount/selection effects are now wrapped in
 * `fireAndForget`. The service list chain had no `.catch`, so a failure used to
 * be an unhandled rejection; it is now logged. The spec chain keeps its
 * existing `setError` handling.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import DocsPage from '../page';

const SERVICES = [
  { name: 'auth', description: 'Auth service', url: 'https://auth.example', spec: '/auth/spec' },
  { name: 'meta', description: 'No spec', url: 'https://meta.example', spec: '' },
];

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('service list load', () => {
  it('lists services that have a spec and selects the first one', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/registry/api/specs') return json({ services: SERVICES });
      if (url === '/registry/api/specs/auth') return json({ openapi: '3.0.0', info: { title: 'Auth' }, paths: {} });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<DocsPage />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/registry/api/specs/auth'));
    expect(screen.queryByText('meta')).toBeNull();
  });

  it('logs instead of rejecting when the service list cannot be loaded', async () => {
    const boom = new Error('registry down');
    vi.stubGlobal('fetch', vi.fn(async () => { throw boom; }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<DocsPage />);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[registry:docs:loadSpecs] unhandled async error', boom),
    );
  });
});

describe('spec load', () => {
  it('shows the existing error message when the spec request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/registry/api/specs') return json({ services: SERVICES });
      return json({}, false, 502);
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<DocsPage />);

    expect(await screen.findByText('Could not load spec for auth')).toBeDefined();
    // The chain already had a catch, so fireAndForget has nothing to log.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

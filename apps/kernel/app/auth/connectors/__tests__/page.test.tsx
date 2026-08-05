// @vitest-environment jsdom
/**
 * Connections landing grid tests (#1604).
 *
 * `deriveConnected` read only `tokenSealed`, so Gemini (`keySealed`) and Warp
 * (`secretSealed`) rendered "Not connected" on this page with a credential
 * actually sealed — the same normalisation gap that made the detail view render
 * "Coming soon". These tests pin the per-connector flag names.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import ConnectionsPage from '../page';

// next/link needs an app-router context that does not exist outside the Next
// runtime; the grid only uses it to navigate to the detail route.
vi.mock('next/link', () => ({
  default: ({ href, children }: Readonly<{ href: string; children: React.ReactNode }>) => (
    <a href={href}>{children}</a>
  ),
}));

type StatusBody = Record<string, unknown>;

function jsonResponse(body: StatusBody, ok = true): Response {
  return { ok, status: ok ? 200 : 401, json: async () => body } as unknown as Response;
}

/** Signed-in session plus a status body per connector endpoint. */
function installFetch(bodies: Record<string, StatusBody>, sessionOk = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/api/session') return jsonResponse({}, sessionOk);
      return jsonResponse(bodies[url] ?? {}, url in bodies);
    }),
  );
}

/** The pill text rendered inside a given connector's card. */
function pillFor(name: string): string {
  const heading = screen.getByText(name);
  const card = heading.closest('a');
  if (!card) throw new Error(`no card found for ${name}`);
  const pill = card.querySelector('span[class*="rounded"]');
  return pill?.textContent ?? '';
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('connector status pills', () => {
  it('reports Gemini connected from `keySealed`', async () => {
    installFetch({ '/gemini/api/scope-manifest': { activeScopes: [], keySealed: true } });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(pillFor('Google Gemini')).toContain('Connected');
    });
  });

  it('reports Warp connected from `secretSealed`', async () => {
    installFetch({ '/warp/api/scope-manifest': { activeScopes: [], secretSealed: true } });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(pillFor('Warp Cloud Agents')).toContain('Connected');
    });
  });

  it('reports Discord connected from `tokenSealed`', async () => {
    installFetch({ '/discord/api/scope-manifest': { activeScopes: [], tokenSealed: true } });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(pillFor('Discord')).toContain('Connected');
    });
  });

  it('reports a native connector connected from its active scopes, not a credential', async () => {
    installFetch({ '/mcp/api/scope-manifest': { activeScopes: ['media:read'] } });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(pillFor('Claude / MCP')).toContain('Connected');
    });
  });

  it('reports not connected when nothing is sealed', async () => {
    installFetch({ '/gemini/api/scope-manifest': { activeScopes: [], keySealed: false } });

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(pillFor('Google Gemini')).toContain('Not connected');
    });
  });

  it('reports an unreachable status endpoint as unavailable', async () => {
    installFetch({});

    render(<ConnectionsPage />);

    await waitFor(() => {
      expect(pillFor('Google Gemini')).toContain('Unavailable');
    });
  });
});

describe('session gating', () => {
  it('asks an unauthenticated visitor to sign in instead of listing connectors', async () => {
    installFetch({}, false);

    render(<ConnectionsPage />);

    expect(await screen.findByText('Sign In')).toBeDefined();
    expect(screen.queryByText('Google Gemini')).toBeNull();
  });
});

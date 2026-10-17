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
import { render, screen, cleanup, within } from '@testing-library/react';
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
function installFetch(bodies: Record<string, StatusBody | Promise<StatusBody>>, sessionOk = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/api/session') return jsonResponse({}, sessionOk);
      return jsonResponse(await (bodies[url] ?? {}), url in bodies);
    }),
  );
}

/** Wait for the settled pill inside a given connector's card, not just the card. */
async function pillFor(name: string, text: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name);
  const card = heading.closest('a');
  if (!card) throw new Error(`no card found for ${name}`);
  return within(card).findByText(text);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('connector status pills', () => {
  it('reports Gemini connected from `keySealed`', async () => {
    let resolveStatus!: (body: StatusBody) => void;
    const status = new Promise<StatusBody>((resolve) => { resolveStatus = resolve; });
    installFetch({ '/gemini/api/scope-manifest': status });

    render(<ConnectionsPage />);

    expect(await pillFor('Google Gemini', 'Checking…')).toBeDefined();
    resolveStatus({ activeScopes: [], keySealed: true });
    expect(await pillFor('Google Gemini', '● Connected')).toBeDefined();
  });

  it('reports Warp connected from `secretSealed`', async () => {
    installFetch({ '/warp/api/scope-manifest': { activeScopes: [], secretSealed: true } });

    render(<ConnectionsPage />);

    expect(await pillFor('Warp Cloud Agents', '● Connected')).toBeDefined();
  });

  it('reports Discord connected from `tokenSealed`', async () => {
    installFetch({ '/discord/api/scope-manifest': { activeScopes: [], tokenSealed: true } });

    render(<ConnectionsPage />);

    expect(await pillFor('Discord', '● Connected')).toBeDefined();
  });

  it('reports a native connector connected from its active scopes, not a credential', async () => {
    installFetch({ '/mcp/api/scope-manifest': { activeScopes: ['media:read'] } });

    render(<ConnectionsPage />);

    expect(await pillFor('Imajin MCP', '● Connected')).toBeDefined();
  });

  it('reports not connected when nothing is sealed', async () => {
    installFetch({ '/gemini/api/scope-manifest': { activeScopes: [], keySealed: false } });

    render(<ConnectionsPage />);

    expect(await pillFor('Google Gemini', '○ Not connected')).toBeDefined();
  });

  it('reports an unreachable status endpoint as unavailable', async () => {
    installFetch({});

    render(<ConnectionsPage />);

    expect(await pillFor('Google Gemini', 'Unavailable')).toBeDefined();
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

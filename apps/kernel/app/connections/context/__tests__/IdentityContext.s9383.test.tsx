// @vitest-environment jsdom
/**
 * IdentityProvider — the mount effect fires checkSession() via fireAndForget
 * (typescript:S9383). Behaviour must be unchanged, and a rejection must be
 * logged rather than surfacing as an unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { IdentityProvider, useIdentity } from '../IdentityContext';

function Probe() {
  const { did, handle, type, isLoggedIn, loading } = useIdentity();
  return (
    <div data-testid="probe">
      {String(loading)}|{String(isLoggedIn)}|{did ?? '-'}|{handle ?? '-'}|{type ?? '-'}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IdentityProvider mount effect', () => {
  it('checks the session on mount and exposes the identity', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ did: 'did:imajin:a', handle: 'alice', type: 'human' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    render(<IdentityProvider><Probe /></IdentityProvider>);

    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('false|true|did:imajin:a|alice|human'),
    );
    expect(fetchSpy).toHaveBeenCalledWith('/auth/api/session');
  });

  it('stays logged out when the session endpoint is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    render(<IdentityProvider><Probe /></IdentityProvider>);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false|false|-|-|-'));
  });

  it('logs and swallows a fetch failure (existing handling)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<IdentityProvider><Probe /></IdentityProvider>);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false|false|-|-|-'));
    expect(errorSpy).toHaveBeenCalledWith('Session check failed:', expect.any(Error));
  });

  it('logs through fireAndForget when checkSession itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const boom = new Error('console broke');
    // First console.error call is checkSession's own catch handler; making it
    // throw turns checkSession into a rejected promise.
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementationOnce(() => { throw boom; })
      .mockImplementation(() => {});

    render(<IdentityProvider><Probe /></IdentityProvider>);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[identity:checkSession] unhandled async error', boom),
    );
  });
});

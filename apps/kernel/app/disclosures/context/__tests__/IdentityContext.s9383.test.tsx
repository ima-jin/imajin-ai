// @vitest-environment jsdom
/**
 * Disclosures IdentityProvider — S9383 floating-promise fix (#2568).
 *
 * The mount effect fires `checkSession()` without awaiting it; it now goes
 * through `fireAndForget`. Behaviour is unchanged and a rejection is logged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { IdentityProvider, useIdentity } from '../IdentityContext';

function Probe() {
  const { did, handle, isLoggedIn, loading } = useIdentity();
  return (
    <div data-testid="probe">
      {loading ? 'loading' : 'ready'}|{String(isLoggedIn)}|{did ?? '-'}|{handle ?? '-'}
    </div>
  );
}

function renderProvider() {
  render(
    <IdentityProvider>
      <Probe />
    </IdentityProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session check on mount', () => {
  it('loads the session identity', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ did: 'did:imajin:alice', handle: 'alice', type: 'human' }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|true|did:imajin:alice|alice'));
    expect(fetchSpy).toHaveBeenCalledWith('/auth/api/session');
  });

  it('stays logged out and stops loading on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|false|-|-'));
    expect(errorSpy).toHaveBeenCalledWith('Session check failed:', expect.any(Error));
  });

  it('logs through fireAndForget instead of rejecting when checkSession itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const boom = new Error('console broke');
    // First call is the component's own catch-block log: make it throw so the
    // promise returned by checkSession() rejects.
    const errorSpy = vi.spyOn(console, 'error').mockImplementationOnce(() => { throw boom; }).mockImplementation(() => {});

    renderProvider();

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[disclosures:checkSession] unhandled async error', boom),
    );
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|false|-|-'));
  });
});

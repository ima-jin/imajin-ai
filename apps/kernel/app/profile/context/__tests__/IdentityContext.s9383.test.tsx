// @vitest-environment jsdom
/**
 * Profile IdentityProvider — S9383 floating-promise fix (#2568).
 *
 * `loadIdentity().finally(...)` had no rejection handling. It is now wrapped in
 * `fireAndForget`: `setIsLoading(false)` still runs in `finally`, and a
 * rejection is logged instead of becoming an unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { IdentityProvider, useIdentity } from '../IdentityContext';

function Probe() {
  const { did, isLoggedIn, isLoading } = useIdentity();
  return (
    <div data-testid="probe">
      {isLoading ? 'loading' : 'ready'}|{String(isLoggedIn)}|{did ?? '-'}
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

describe('identity load on mount', () => {
  it('logs in from the auth session and clears the loading flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ did: 'did:imajin:alice', handle: 'alice' }),
    }) as unknown as Response));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|true|did:imajin:alice'));
  });

  it('logs the rejection, and still clears the loading flag, when loadIdentity throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('storage unavailable');
    // The network-error fallback reads localStorage; make that throw so the
    // promise returned by loadIdentity() rejects.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw boom;
    });

    renderProvider();

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[profile:loadIdentity] unhandled async error', boom),
    );
    expect(screen.getByTestId('probe').textContent).toBe('ready|false|-');
  });
});

// @vitest-environment jsdom
/**
 * Kernel IdentityProvider — S9383 floating-promise fix (#2568).
 *
 * The mount effect fires `checkSession()` without awaiting it; it now goes
 * through `fireAndForget`. Behaviour is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

const { IdentityProvider, useIdentity } = await import('../IdentityContext');

function Probe() {
  const { identity, loading, error } = useIdentity();
  return (
    <div data-testid="probe">
      {loading ? 'loading' : 'ready'}|{identity?.did ?? '-'}|{identity?.scope ?? '-'}|{error ?? '-'}
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
  it('loads the identity from the session response', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ identity: { id: 'did:imajin:alice', handle: 'alice' } }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|did:imajin:alice|actor|-'));
    expect(fetchSpy).toHaveBeenCalledWith('/auth/api/session');
  });

  it('clears the identity when the session is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as unknown as Response));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready|-|-|-'));
  });

  it('reports an error without rejecting when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('ready|-|-|Failed to check session'),
    );
    // checkSession handles its own failure, so fireAndForget never logs.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

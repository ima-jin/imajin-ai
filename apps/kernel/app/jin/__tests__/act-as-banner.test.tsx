// @vitest-environment jsdom
/**
 * Component tests for the persistent /jin act-as banner (#2359): present
 * whenever the acting DID differs from the real session DID, absent
 * otherwise, and the one-click drop posts the same `{ did: null }` the
 * IdentitySwitcher's "Personal" entry does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { ActAsBanner } from '../act-as-banner';

const SESSION_DID = 'did:imajin:ryan-operator';
const GROUP_DID = 'did:imajin:some-group';

function installFetch(ok = true) {
  const spy = vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => ({}) } as unknown as Response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ActAsBanner presence (#2359)', () => {
  it('renders when the acting DID differs from the session DID, naming both identities', () => {
    render(<ActAsBanner sessionDid={SESSION_DID} actingDid={GROUP_DID} />);

    const banner = screen.getByTestId('act-as-banner');
    expect(banner.textContent).toContain(SESSION_DID);
    expect(banner.textContent).toContain(GROUP_DID);
    expect(banner.textContent).toContain('self-only');
  });

  it('renders nothing when the acting DID is the session DID', () => {
    const { container } = render(<ActAsBanner sessionDid={SESSION_DID} actingDid={SESSION_DID} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('act-as-banner')).toBeNull();
  });

  it('renders nothing when signed out (no session DID at all)', () => {
    const { container } = render(<ActAsBanner sessionDid={null} actingDid={null} />);

    expect(container.firstChild).toBeNull();
  });
});

describe('ActAsBanner drop (#2359)', () => {
  it('posts did: null to the act-as endpoint on one click', async () => {
    const spy = installFetch();
    // jsdom refuses a real navigation; the banner only ever calls reload().
    vi.stubGlobal('location', { reload: vi.fn() });

    render(<ActAsBanner sessionDid={SESSION_DID} actingDid={GROUP_DID} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop act-as' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/api/session/act-as');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ did: null });
  });

  it('re-enables the button when the drop is refused, rather than stranding it', async () => {
    installFetch(false);

    render(<ActAsBanner sessionDid={SESSION_DID} actingDid={GROUP_DID} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop act-as' }));

    await waitFor(() => {
      const button = screen.getByRole('button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Drop act-as');
    });
  });
});

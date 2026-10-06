// @vitest-environment jsdom
/**
 * IdentitySettingsPanel — typescript:S9383 (#2568).
 *
 * The mount-effect `loadData()` and the clipboard copy chain are wrapped in
 * `fireAndForget(...)`. These tests pin unchanged behaviour and that a
 * clipboard rejection is logged through console.error instead of becoming an
 * unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@imajin/config', () => ({
  SERVICES: [],
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

import IdentitySettingsPanel from '../IdentitySettingsPanel';

const GROUP_DID = 'did:imajin:group';

function installFetch() {
  const spy = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      enabledServices: [],
      landingService: null,
      joinVisibility: 'invite',
      joinNetworkDepth: 2,
      scopeFeeBps: 50,
      theme: {},
    }),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IdentitySettingsPanel fire-and-forget calls', () => {
  it('loads config on mount', async () => {
    const fetchSpy = installFetch();
    render(<IdentitySettingsPanel groupDid={GROUP_DID} />);

    await waitFor(() => expect(screen.getByText('Save Changes')).toBeDefined());
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://profile.example/api/forest/${encodeURIComponent(GROUP_DID)}/config`,
      { credentials: 'include' },
    );
    expect(screen.getByText('50 basis points · Collected on every transaction within this scope')).toBeDefined();
  });

  it('copies the onboarding link and shows the Copied! label', async () => {
    installFetch();
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    render(<IdentitySettingsPanel groupDid={GROUP_DID} />);
    await waitFor(() => expect(screen.getByText('Copy')).toBeDefined());

    fireEvent.click(screen.getByText('Copy'));

    await waitFor(() => expect(screen.getByText('Copied!')).toBeDefined());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toContain(
      `/auth/onboard?scope=${encodeURIComponent(GROUP_DID)}`,
    );
  });

  it('logs a clipboard rejection through console.error without unhandled rejection', async () => {
    installFetch();
    const err = new Error('clipboard denied');
    installClipboard(vi.fn(() => Promise.reject(err)));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<IdentitySettingsPanel groupDid={GROUP_DID} />);
    await waitFor(() => expect(screen.getByText('Copy')).toBeDefined());

    fireEvent.click(screen.getByText('Copy'));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[auth:identitySettings:clipboard] unhandled async error', err),
    );
    expect(screen.getByText('Copy')).toBeDefined();
  });
});

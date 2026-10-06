// @vitest-environment jsdom
/**
 * SecuritySettingsPage — typescript:S9383 (#2568).
 *
 * The mount effect wraps `loadData()` in `fireAndForget(...)`. These tests
 * pin that the session / methods / devices requests are still issued on mount
 * and that loading finishes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('../components/RecoveryCodesSection', () => ({ default: () => <div>recovery-section</div> }));
vi.mock('../components/PasswordLoginSection', () => ({ default: () => <div>password-section</div> }));
vi.mock('../components/TotpSection', () => ({ default: () => <div>totp-section</div> }));
vi.mock('../components/EmailMfaSection', () => ({ default: () => <div>email-section</div> }));
vi.mock('../components/DevicesSection', () => ({
  default: ({ devices }: { devices: unknown[] }) => <div>devices-section:{devices.length}</div>,
}));

import SecuritySettingsPage from '../page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SecuritySettingsPage mount load', () => {
  it('loads session, methods and devices on mount', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === '/auth/api/session') return { ok: true, json: async () => ({ did: 'did:imajin:me' }) };
      if (url.startsWith('/auth/api/account/methods')) {
        return { ok: true, json: async () => ({ did: 'did:imajin:me', hasStoredKey: false, mfaMethods: [] }) };
      }
      return { ok: true, json: async () => ({ devices: [{ id: 'd1' }] }) };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { findByText } = render(<SecuritySettingsPage />);

    await findByText('devices-section:1');
    expect(fetchSpy).toHaveBeenCalledWith('/auth/api/session', { credentials: 'include' });
    expect(fetchSpy).toHaveBeenCalledWith('/auth/api/account/methods?did=did%3Aimajin%3Ame');
    expect(fetchSpy).toHaveBeenCalledWith('/auth/api/devices', { credentials: 'include' });
  });

  it('logs and finishes loading when the load request fails', async () => {
    const err = new Error('offline');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<SecuritySettingsPage />);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('Failed to load security settings:', err),
    );
  });
});

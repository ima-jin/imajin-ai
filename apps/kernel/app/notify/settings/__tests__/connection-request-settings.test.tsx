// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SettingsPage from '../page';
import NotificationsPage from '../../../auth/notifications/page';

const scope = 'connection:request-received';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  ['notify/settings', SettingsPage],
  ['auth/notifications', NotificationsPage],
] as const)('%s direct request preferences', (_name, Page) => {
  it.each(['email', 'inapp'] as const)('renders a mobile-stackable row and saves the %s opt-out', async (channel) => {
    const fetch = vi.fn(async (_url: string, options?: RequestInit) => ({
      ok: true,
      json: async () => options?.method === 'PUT'
        ? { preference: { scope, email: channel !== 'email', inapp: channel !== 'inapp' } }
        : { preferences: [] },
    }));
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    const label = await screen.findByText('Connection request received');
    const row = label.parentElement!;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('sm:flex-row');
    const button = within(row).getByRole('button', { name: channel === 'email' ? 'Email' : 'In-app' });
    fireEvent.click(button);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      `/notify/api/preferences/${encodeURIComponent(scope)}`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ [channel]: false }) }),
    ));
    await waitFor(() => expect(button.className).toContain('bg-zinc-700'));
    expect(screen.getByText('Invitation accepted')).toBeDefined();
  });
});

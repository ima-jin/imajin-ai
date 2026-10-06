// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RecipientPicker, { BUSINESS_EMPTY_MESSAGE } from '../RecipientPicker';

// Use the real ConnectionPicker (not the whole @imajin/ui barrel) so the test
// covers the emptyMessage wiring end to end.
vi.mock('@imajin/ui', async () => {
  const { ConnectionPicker } = await import('../../../../../../../packages/ui/src/connection-picker');
  return { ConnectionPicker };
});

function renderPicker() {
  return render(
    <RecipientPicker
      mode="connection"
      onModeChange={vi.fn()}
      selectedConnection={null}
      onSelectConnection={vi.fn()}
      invite={{ email: '', delivery: 'email', note: '' }}
      onInviteChange={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RecipientPicker — business empty state (#2651)', () => {
  it("explains the list is the business's connections and points to adding a client or Invite new", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ connections: [] }) })));
    renderPicker();

    const message = await screen.findByText(BUSINESS_EMPTY_MESSAGE);
    expect(message.textContent).toMatch(/this business's connections/);
    expect(message.textContent).toMatch(/client/);
    expect(message.textContent).toMatch(/Invite new/);
    expect(screen.queryByText('No connections available.')).toBeNull();
  });

  it('shows an error rather than the business empty state when the connections request is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    renderPicker();

    expect((await screen.findByRole('alert')).textContent).toBe("You don't have permission to view these connections.");
    expect(screen.queryByText(BUSINESS_EMPTY_MESSAGE)).toBeNull();
  });
});

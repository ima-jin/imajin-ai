// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RecipientPicker, { BUSINESS_EMPTY_MESSAGE } from '../RecipientPicker';

// Use the real ConnectionPicker (not the whole @imajin/ui barrel) so the test
// covers the emptyMessage wiring end to end.
vi.mock('@imajin/ui', async () => {
  const { ConnectionPicker } = await import('../../../../../../../packages/ui/src/connection-picker');
  return { ConnectionPicker };
});

describe('RecipientPicker — relationship labels (#2945)', () => {
  it('enables client filtering while retaining all connected recipients by default', async () => {
    const vendor = { did: 'did:imajin:vendor', name: 'Vendor', handle: null, avatar: null, relationshipLabel: 'vendor' };
    const client = { did: 'did:imajin:client', name: 'Client', handle: null, avatar: null, relationshipLabel: 'client' };
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ connections: [vendor, client] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const onSelectConnection = vi.fn();
    const onModeChange = vi.fn();
    render(<RecipientPicker mode="connection" onModeChange={onModeChange} selectedConnection={null} onSelectConnection={onSelectConnection} invite={{ email: '', delivery: 'email', note: '' }} onInviteChange={vi.fn()} />);
    await screen.findByText('Vendor');
    expect(fetchSpy).toHaveBeenCalledWith('/connections/api/connections', { credentials: 'include' });
    fireEvent.click(screen.getByRole('button', { name: 'Clients' }));
    expect(screen.queryByText('Vendor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Client client/ }));
    expect(onSelectConnection).toHaveBeenCalledWith(client);
    fireEvent.click(screen.getByRole('tab', { name: 'Invite new' }));
    expect(onModeChange).toHaveBeenCalledWith('invite');
  });

  it('displays the selected connection label and allows clearing the selection', () => {
    const onSelectConnection = vi.fn();
    render(<RecipientPicker mode="connection" onModeChange={vi.fn()} selectedConnection={{ did: 'did:imajin:c', name: 'Client Co', handle: null, relationshipLabel: 'client' }} onSelectConnection={onSelectConnection} invite={{ email: '', delivery: 'email', note: '' }} onInviteChange={vi.fn()} />);
    expect(screen.getByText('client')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(onSelectConnection).toHaveBeenCalledWith(null);
  });

  it('preserves invite-new inputs without fetching or filtering connections', () => {
    const fetchSpy = vi.fn();
    const onInviteChange = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<RecipientPicker mode="invite" onModeChange={vi.fn()} selectedConnection={null} onSelectConnection={vi.fn()} invite={{ email: '', delivery: 'email', note: '' }} onInviteChange={onInviteChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: 'client@example.com' } });
    expect(onInviteChange).toHaveBeenCalledWith({ email: 'client@example.com', delivery: 'email', note: '' });
    expect(screen.queryByRole('group', { name: 'Filter relationships' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
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

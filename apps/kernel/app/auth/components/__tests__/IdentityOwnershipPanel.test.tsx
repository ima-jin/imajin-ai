// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IdentityOwnershipPanel, { type OwnershipState } from '../IdentityOwnershipPanel';

const { refresh, navigate, setActingAs } = vi.hoisted(() => ({ refresh: vi.fn(), navigate: vi.fn(), setActingAs: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@imajin/ui/server', () => ({ setActingAs }));

const GROUP = 'did:imajin:business';
const OWNER = 'did:imajin:alice';
const RECIPIENT = 'did:imajin:bob';
const endpoint = `/auth/api/groups/${encodeURIComponent(GROUP)}/transfer-owner`;
const proposal = { id: 'transfer_1', from: OWNER, to: RECIPIENT, by: OWNER, policy: 'owner-only', createdAt: '2026-10-17T20:00:00Z' };

let state: OwnershipState;
let fetchMock: ReturnType<typeof vi.fn>;

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    groupDid: GROUP, groupName: 'GBS Contracting', ownerDid: OWNER, policy: 'owner-only',
    pendingTransfer: null, viewerDid: OWNER, viewerRole: 'owner', canTransfer: true, canAccept: false,
  };
  fetchMock = vi.fn(() => reply(state));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { assign: navigate });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  render(<IdentityOwnershipPanel groupDid={GROUP} />);
  await screen.findByText('GBS Contracting');
}

function submit() {
  fireEvent.change(screen.getByLabelText('New owner DID'), { target: { value: ` ${RECIPIENT} ` } });
  fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));
}

describe('ownership settings', () => {
  it('loads current ownership without caching and disables an empty transfer', async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledWith(endpoint, { credentials: 'include', cache: 'no-store' });
    expect(screen.getByText(OWNER)).toBeTruthy();
    expect(screen.getByText('owner-only')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Transfer ownership' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('proposes a transfer and displays the shareable pending acceptance link', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') state = { ...state, pendingTransfer: proposal };
      return reply(state, init?.method === 'POST' ? 201 : 200);
    });
    await mount();
    submit();
    await screen.findByText('Pending acceptance');
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ newOwnerDid: RECIPIENT }), credentials: 'include',
    }));
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/auth/groups/${encodeURIComponent(GROUP)}/ownership`);
    expect(refresh).toHaveBeenCalled();
  });

  it('cancels the precise pending proposal and restores the form', async () => {
    state.pendingTransfer = proposal;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') state = { ...state, pendingTransfer: null };
      return reply(state);
    });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel transfer' }));
    await screen.findByRole('button', { name: 'Transfer ownership' });
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ transferId: proposal.id }),
    }));
  });

  it('lets the named invitee accept and refreshes the displayed owner', async () => {
    state = { ...state, pendingTransfer: proposal, viewerDid: RECIPIENT, viewerRole: null, canTransfer: false, canAccept: true };
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') state = { ...state, pendingTransfer: null, ownerDid: RECIPIENT, viewerRole: 'owner', canTransfer: true, canAccept: false };
      return reply(state);
    });
    await mount();
    expect(screen.queryByRole('button', { name: 'Cancel transfer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept ownership' }));
    await screen.findByText('Ownership accepted. You are now the owner.');
    expect(fetchMock).toHaveBeenCalledWith(`${endpoint}/accept`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ transferId: proposal.id }),
    }));
    await waitFor(() => expect(screen.getByText(RECIPIENT)).toBeTruthy());
  });

  it('shows an admin read-only ownership and allows leaving', async () => {
    state = { ...state, ownerDid: RECIPIENT, viewerRole: 'admin', canTransfer: false };
    await mount();
    expect(screen.queryByLabelText('New owner DID')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave identity' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth'));
    expect(setActingAs).toHaveBeenCalledWith(null);
    expect(fetchMock).toHaveBeenCalledWith(
      `/auth/api/groups/${encodeURIComponent(GROUP)}/controllers/${encodeURIComponent(OWNER)}`,
      { method: 'DELETE', credentials: 'include' },
    );
  });

  it('does not expose transfer, cancel, or accept to another member', async () => {
    state = { ...state, pendingTransfer: proposal, viewerRole: 'member', canTransfer: false };
    await mount();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('surfaces approval-required responses without changing ownership', async () => {
    await mount();
    fetchMock.mockImplementation(() => reply({ code: 'AGENT_APPROVAL_REQUIRED', error: 'Denied' }, 403));
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('Owner approval required');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('displays load errors rather than an indefinite loading state', async () => {
    fetchMock.mockImplementation(() => reply({ error: 'Not a member or recipient' }, 403));
    render(<IdentityOwnershipPanel groupDid={GROUP} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Not a member or recipient');
    expect(screen.queryByText('Loading ownership…')).toBeNull();
  });

  it('displays mutation failures and re-enables the controls', async () => {
    await mount();
    fetchMock.mockImplementation(() => reply({}, 409));
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('Unable to update ownership.');
    expect((screen.getByRole('button', { name: 'Transfer ownership' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('handles network failures for both transfer and leave', async () => {
    await mount();
    fetchMock.mockRejectedValue(new Error('Offline'));
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('Offline');
    cleanup();
    state = { ...state, viewerRole: 'admin', canTransfer: false };
    fetchMock.mockImplementation(() => reply(state));
    await mount();
    fetchMock.mockRejectedValue(new Error('Still offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave identity' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Still offline'));
    expect(navigate).not.toHaveBeenCalled();
    expect(setActingAs).not.toHaveBeenCalled();
  });
});

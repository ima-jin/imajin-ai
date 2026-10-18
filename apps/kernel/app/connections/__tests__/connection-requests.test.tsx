// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConnectionRequests from '../connection-requests';

const ORG = 'did:imajin:business';
const PERSON = 'did:imajin:person';
const refreshSent = vi.fn();
const refreshReceived = vi.fn();
const request = {
  code: 'direct-code', fromDid: ORG, fromHandle: 'business', fromName: 'The Business',
  toDid: PERSON, toHandle: 'person', toName: 'Counterparty', delivery: 'direct', status: 'pending',
};
let sent = { invites: [request], effectiveDid: ORG, effectiveName: 'The Business' };
let received = { invites: [] as typeof request[] };
let listError: Error | undefined;

vi.mock('swr', () => ({
  default: (url: string) => url.includes('incoming')
    ? { data: received, mutate: refreshReceived, error: listError }
    : { data: sent, mutate: refreshSent, error: listError },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  sent = { invites: [request], effectiveDid: ORG, effectiveName: 'The Business' };
  received = { invites: [] };
  listError = undefined;
  globalThis.history.replaceState({}, '', '/connections');
});

function setupFetch(ok = true, error?: string) {
  const fetch = vi.fn(async () => ({ ok, json: async () => ({ error }) }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('org connection requests', () => {
  it('identifies the org acting DID and distinguishes requests from connections', () => {
    render(<ConnectionRequests onConnected={vi.fn()} />);
    expect(screen.getByText(/Requesting connections as The Business/).textContent).toContain(ORG);
    expect(screen.getByText(/A connection gives no membership/)).toBeDefined();
    expect(screen.getByRole('region', { name: 'Sent connection requests' }).textContent).toContain('Counterparty');
    expect(screen.getByText(/awaiting acceptance/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it.each([
    ['@person', { handle: '@person' }],
    [PERSON, { toDid: PERSON }],
  ])('requests an existing identity using %s without selecting or adding a member', async (target, body) => {
    const fetch = setupFetch();
    const onConnected = vi.fn();
    render(<ConnectionRequests onConnected={onConnected} />);
    fireEvent.change(screen.getByLabelText('Handle or DID'), { target: { value: target } });
    fireEvent.click(screen.getByRole('button', { name: 'Send connection request' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('They must accept'));
    expect(fetch).toHaveBeenCalledWith('/connections/api/invites', expect.objectContaining({
      method: 'POST', body: JSON.stringify(body),
    }));
    expect(refreshSent).toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('lets the org owner cancel a sent request', async () => {
    const fetch = setupFetch();
    render(<ConnectionRequests onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('cancelled'));
    expect(fetch).toHaveBeenCalledWith('/connections/api/invites/direct-code', expect.objectContaining({ method: 'DELETE' }));
  });

  it.each(['accept', 'decline'] as const)('shows the requesting org to the recipient and allows %s', async (action) => {
    sent.invites = [];
    received.invites = [request];
    const fetch = setupFetch();
    const onConnected = vi.fn();
    render(<ConnectionRequests onConnected={onConnected} />);
    expect(screen.getByRole('region', { name: 'Incoming connection requests' }).textContent).toContain('The Business');
    expect(screen.getByText(ORG)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Accept' : 'Decline' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(action === 'accept' ? 'accepted' : 'declined'));
    expect(fetch).toHaveBeenCalledWith(
      `/connections/api/invites/direct-code${action === 'accept' ? '/accept' : ''}`,
      expect.objectContaining(action === 'accept' ? { method: 'POST' } : { method: 'PATCH', body: '{"action":"decline"}' }),
    );
    expect(onConnected).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
    expect(refreshReceived).toHaveBeenCalled();
  });

  it('does not show email invites or terminal requests as pending requests', () => {
    sent.invites = [
      { ...request, delivery: 'email' },
      { ...request, status: 'accepted' },
      { ...request, status: 'declined' },
    ];
    render(<ConnectionRequests onConnected={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
  });

  it('shows actionable server errors without reporting a connection', async () => {
    setupFetch(false, 'Already connected');
    const onConnected = vi.fn();
    render(<ConnectionRequests onConnected={onConnected} />);
    fireEvent.change(screen.getByLabelText('Handle or DID'), { target: { value: '@person' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send connection request' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Already connected');
    expect(onConnected).not.toHaveBeenCalled();
    expect(refreshSent).not.toHaveBeenCalled();
  });

  it('reports network errors for actions and leaves connections unchanged', async () => {
    received.invites = [request];
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network unavailable'); }));
    const onConnected = vi.fn();
    render(<ConnectionRequests onConnected={onConnected} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Network unavailable');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('reports request list failures instead of claiming there are no requests', () => {
    listError = new Error('Unauthorized');
    render(<ConnectionRequests onConnected={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load connection requests');
  });

  it('focuses the connect input when following the member guardrail link', () => {
    globalThis.history.replaceState({}, '', '/connections?connect=1');
    render(<ConnectionRequests onConnected={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Handle or DID'));
  });
});

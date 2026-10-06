// @vitest-environment jsdom
/**
 * ConnectionsPage — NicknameEditor save()/clear() and the Disconnect handler
 * are fired via fireAndForget (typescript:S9383). Behaviour must be unchanged
 * and a rejection must be logged through console.error instead of becoming an
 * unhandled rejection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ConnectionsPage from '../page';

const mutateConnections = vi.fn();
const toastError = vi.fn();

const connection = {
  did: 'did:imajin:friend',
  handle: 'friend',
  name: 'Friend',
  connectedAt: '2026-01-01T00:00:00Z',
  nickname: null as string | null,
};
let connectionsData = { connections: [connection] };

vi.mock('../context/IdentityContext', () => ({
  useIdentity: () => ({ did: 'did:imajin:me', isLoggedIn: true, loading: false }),
}));

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/connections/api/connections') return { data: connectionsData, mutate: mutateConnections };
    return { data: undefined, mutate: vi.fn() };
  },
}));

vi.mock('../invitations-tab', () => ({ default: () => null }));

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: { error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() } }),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

const NICK_URL = '/connections/api/connections/did%3Aimajin%3Afriend/nickname';

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function openNicknameEditor() {
  fireEvent.click(screen.getByTitle('Edit nickname'));
  return (await screen.findByPlaceholderText('Set nickname…')) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  connectionsData = { connections: [{ ...connection, nickname: null }] };
  mutateConnections.mockReset();
  toastError.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NicknameEditor save() via Enter', () => {
  it('PATCHes the nickname and closes the editor', async () => {
    const spy = stubFetch(async () => ({ ok: true }));
    render(<ConnectionsPage />);

    const input = await openNicknameEditor();
    fireEvent.change(input, { target: { value: '  Bestie  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByPlaceholderText('Set nickname…')).toBeNull());
    expect(spy).toHaveBeenCalledWith(NICK_URL, expect.objectContaining({ method: 'PATCH' }));
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ nickname: 'Bestie' });
    // optimistic update of the SWR cache
    expect(mutateConnections).toHaveBeenCalled();
  });

  it('logs a save rejection via console.error and does not reject', async () => {
    const err = new Error('network down');
    stubFetch(async () => { throw err; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    render(<ConnectionsPage />);

    const input = await openNicknameEditor();
    fireEvent.change(input, { target: { value: 'Bestie' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[connections:nickname:save] unhandled async error', err),
    );
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('NicknameEditor clear() via the × button', () => {
  function withNickname() {
    connectionsData = { connections: [{ ...connection, nickname: 'Bestie' }] };
  }

  it('DELETEs the nickname and closes the editor', async () => {
    withNickname();
    const spy = stubFetch(async () => ({ ok: true }));
    render(<ConnectionsPage />);

    await openNicknameEditor();
    fireEvent.mouseDown(screen.getByTitle('Clear nickname'));

    await waitFor(() => expect(screen.queryByPlaceholderText('Set nickname…')).toBeNull());
    expect(spy).toHaveBeenCalledWith(NICK_URL, { method: 'DELETE' });
    expect(mutateConnections).toHaveBeenCalled();
  });

  it('logs a clear rejection via console.error and does not reject', async () => {
    withNickname();
    const err = new Error('network down');
    stubFetch(async () => { throw err; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    render(<ConnectionsPage />);

    await openNicknameEditor();
    fireEvent.mouseDown(screen.getByTitle('Clear nickname'));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[connections:nickname:clear] unhandled async error', err),
    );
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('disconnect button', () => {
  it('DELETEs the connection and refreshes the list after confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const spy = stubFetch(async () => ({ ok: true }));
    render(<ConnectionsPage />);

    fireEvent.click(screen.getByTitle('Disconnect'));

    await waitFor(() => expect(mutateConnections).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('/connections/api/connections/did%3Aimajin%3Afriend', { method: 'DELETE' });
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const spy = stubFetch(async () => ({ ok: true }));
    render(<ConnectionsPage />);

    fireEvent.click(screen.getByTitle('Disconnect'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('toasts on an unsuccessful response (existing handling)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    stubFetch(async () => ({ ok: false }));
    render(<ConnectionsPage />);

    fireEvent.click(screen.getByTitle('Disconnect'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to disconnect'));
  });

  it('logs a rejection via console.error when disconnectFrom itself rejects', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    stubFetch(async () => ({ ok: false }));
    const boom = new Error('toast broke');
    // toast.error is called from both the try and the catch block; throwing
    // every time makes disconnectFrom reject.
    toastError.mockImplementation(() => { throw boom; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ConnectionsPage />);

    fireEvent.click(screen.getByTitle('Disconnect'));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[connections:disconnectFrom] unhandled async error', boom),
    );
  });
});
